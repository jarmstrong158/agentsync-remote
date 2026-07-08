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

// Translate an fnmatch-style glob to a RegExp. Like Python's fnmatch, '*' and
// '?' are NOT special about the '/' separator, so 'src/**' matches 'src/api'.
function fnmatchToRegExp(pattern: string): RegExp {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (ch === "[" || ch === "]") re += ch; // pass character classes through
    else re += ch.replace(/[.+^${}()|\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

/** True if two individual path tokens overlap under agentsync semantics. */
export function pathsOverlap(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);

  if (na === nb) return true;

  // (b) directory containment, either direction.
  if (nb.startsWith(na + "/") || na.startsWith(nb + "/")) return true;

  // (c) glob match, either direction.
  if (isGlob(na) && fnmatchToRegExp(na).test(nb)) return true;
  if (isGlob(nb) && fnmatchToRegExp(nb).test(na)) return true;

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
