// Path-overlap semantics, ported verbatim from local agentsync so that the
// remote peer blocks on exactly the same conditions a local peer would.
//
// Two path tokens overlap if:
//   (a) exact match after normalization, or
//   (b) directory containment in either direction
//       ('src/api' vs 'src/api/routes.py' -- prefix + "/"), or
//   (c) glob match in either direction
//       ('src/**', '*.py' -- fnmatch-style, in which '*' is not special about
//        the '/' separator, matching Python's fnmatch).

/** Normalize a path token: trim, drop leading './' or '/', drop trailing '/',
 *  collapse repeated slashes. Globs (`*`, `?`, `[`) are preserved. */
export function normalizePath(p: string): string {
  let s = p.trim();
  s = s.replace(/^\.\//, "");
  s = s.replace(/^\/+/, "");
  s = s.replace(/\/+$/, "");
  s = s.replace(/\/{2,}/g, "/");
  return s;
}

function isGlob(s: string): boolean {
  return /[*?[]/.test(s);
}

// ---------------------------------------------------------------------------
// Glob matching
//
// This used to compile the pattern into a RegExp with `new RegExp("^" + re +
// "$")` and run it against every peer token in both directions. The pattern is
// UNVALIDATED caller input, so `touches: ["a*a*a*a*a*a*a*a*a*b"]` became
// /^a.*a.*a.*a.*a.*a.*a.*a.*a.*b$/ -- a textbook catastrophic-backtracking
// regex. Matched against a long peer path with no trailing 'b' the engine
// explores exponentially many splits, and because claim() re-runs overlap
// detection against fresh state on EVERY compare-and-swap retry, one call
// re-triggered it up to PUSH_RETRIES times. On a Worker that is CPU-time
// exhaustion for the whole isolate, denying the coordination board to every
// peer, and it needs no credentials beyond the path token.
//
// The fix is structural: don't build a regex at all. The pattern is compiled to
// a flat token list and matched with the classic two-pointer glob algorithm,
// which remembers a single backtrack point per '*' and is therefore O(n*m)
// worst case with no exponential blowup. Caps below are defence in depth on top
// of that, and MAX_PATTERN_LENGTH is additionally enforced at the tool boundary
// by the advertised inputSchema (see mcp.ts).
// ---------------------------------------------------------------------------

/** Longest path/glob token we will match. Also advertised as `maxLength` on
 *  `touches`/`requires` items so callers are rejected up front. */
export const MAX_PATTERN_LENGTH = 256;
/** Most wildcard (`*`/`?`) and character-class tokens allowed in one pattern. */
export const MAX_PATTERN_TOKENS = 64;

type GlobToken =
  | { kind: "lit"; ch: string }
  | { kind: "any" } // ?
  | { kind: "star" } // *
  | { kind: "class"; negated: boolean; body: string };

/** Compile an fnmatch-style glob to a token list, or null if it exceeds the
 *  complexity caps (in which case the caller falls back to literal
 *  comparison -- fail SAFE, never fail open and never crash the CAS loop). */
function compileGlob(pattern: string): GlobToken[] | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return null;

  const tokens: GlobToken[] = [];
  let wildcards = 0;
  let i = 0;
  const n = pattern.length;

  while (i < n) {
    const ch = pattern[i];
    if (ch === "*") {
      // Collapse runs of '*': '**' means exactly what '*' means in fnmatch,
      // and collapsing keeps the token count honest.
      while (i < n && pattern[i] === "*") i++;
      if (tokens[tokens.length - 1]?.kind !== "star") {
        tokens.push({ kind: "star" });
        wildcards++;
      }
    } else if (ch === "?") {
      tokens.push({ kind: "any" });
      wildcards++;
      i++;
    } else if (ch === "[") {
      // Character class. Like Python's fnmatch, a leading '!' (or '^') negates
      // it. Scan to the closing ']' (which may be the first class member). If
      // unterminated, treat '[' as a literal.
      let j = i + 1;
      let negated = false;
      if (j < n && (pattern[j] === "!" || pattern[j] === "^")) {
        negated = true;
        j++;
      }
      if (j < n && pattern[j] === "]") j++; // ']' as first member is literal
      while (j < n && pattern[j] !== "]") j++;
      if (j >= n) {
        tokens.push({ kind: "lit", ch: "[" });
        i++;
      } else {
        const start = i + 1 + (negated ? 1 : 0);
        tokens.push({ kind: "class", negated, body: pattern.slice(start, j) });
        wildcards++;
        i = j + 1;
      }
    } else {
      tokens.push({ kind: "lit", ch });
      i++;
    }
    if (wildcards > MAX_PATTERN_TOKENS) return null;
  }
  return tokens;
}

/** Does one character satisfy a character class body (supporting `a-z` ranges,
 *  exactly as the previous regex-backed implementation did)? */
function classMatches(body: string, negated: boolean, ch: string): boolean {
  let hit = false;
  let i = 0;
  while (i < body.length) {
    // A '-' is a range only when it sits between two members.
    if (i + 2 < body.length && body[i + 1] === "-") {
      if (ch >= body[i] && ch <= body[i + 2]) hit = true;
      i += 3;
    } else {
      if (ch === body[i]) hit = true;
      i++;
    }
  }
  return negated ? !hit : hit;
}

function tokenMatchesChar(token: GlobToken, ch: string): boolean {
  switch (token.kind) {
    case "lit":
      return token.ch === ch;
    case "any":
      return true;
    case "class":
      return classMatches(token.body, token.negated, ch);
    case "star":
      return false; // handled by the caller
  }
}

/**
 * Two-pointer glob match. A single remembered backtrack point per '*' bounds
 * the work at O(pattern * text) with no possibility of exponential blowup,
 * which is precisely the property `new RegExp(userInput)` did not have.
 */
function globMatches(tokens: GlobToken[], text: string): boolean {
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;

  while (t < text.length) {
    if (p < tokens.length && tokens[p].kind !== "star" && tokenMatchesChar(tokens[p], text[t])) {
      p++;
      t++;
    } else if (p < tokens.length && tokens[p].kind === "star") {
      starP = p;
      starT = t;
      p++;
    } else if (starP !== -1) {
      // Backtrack: let the last '*' absorb one more character.
      p = starP + 1;
      starT++;
      t = starT;
    } else {
      return false;
    }
  }
  while (p < tokens.length && tokens[p].kind === "star") p++;
  return p === tokens.length;
}

/** fnmatch-style match, safe against adversarial patterns. An over-complex
 *  pattern simply does not glob-match (it is still compared literally by
 *  pathsOverlap), so a hostile pattern can never widen a claim either. */
export function fnmatch(pattern: string, text: string): boolean {
  if (text.length > MAX_PATTERN_LENGTH) return false;
  const tokens = compileGlob(pattern);
  if (tokens === null) return false;
  return globMatches(tokens, text);
}

/** True if two individual path tokens overlap under agentsync semantics. */
export function pathsOverlap(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);

  if (na === nb) return true;

  // (b) directory containment, either direction.
  if (nb.startsWith(na + "/") || na.startsWith(nb + "/")) return true;

  // (c) glob match, either direction.
  if (isGlob(na) && fnmatch(na, nb)) return true;
  if (isGlob(nb) && fnmatch(nb, na)) return true;

  return false;
}

/**
 * Given my tokens and a peer's tokens, return the peer's (normalized, unique,
 * sorted) tokens that overlap any of mine. Used for both `shared_files`
 * (myTouches vs peerTouches) and `depends_on_their_wip` (myRequires vs
 * peerTouches). Reporting the peer's contended tokens reads naturally per-peer:
 * "these files of theirs collide with your work".
 */
export function computeOverlap(mine: string[], theirs: string[]): string[] {
  const out = new Set<string>();
  for (const t of theirs) {
    for (const m of mine) {
      if (pathsOverlap(m, t)) {
        out.add(normalizePath(t));
        break;
      }
    }
  }
  return [...out].sort();
}
