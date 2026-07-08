// Minimal GitHub REST client using plain fetch (no Octokit). Only the endpoints
// agentsync-remote needs: contents (read + compare-and-swap write), git refs
// (branch bootstrap), repo info (default branch), and commits (history).
//
// The GitHub contents API gives us compare-and-swap for free: PUT
// /repos/{owner}/{repo}/contents/{path} requires the current blob `sha`; a
// stale sha returns HTTP 409. That is the remote analogue of local agentsync's
// "git push as CAS" (Decision 3).

import type { Ctx } from "./types.js";

const API = "https://api.github.com";

/** Thrown when GH_PAT is not configured. Surfaced to the model as a clear,
 *  named tool error rather than a generic failure. */
export class GhPatMissingError extends Error {
  constructor() {
    super(
      "The GH_PAT secret is not set on this Worker. Add a fine-grained GitHub " +
        "token (Contents: Read and write, scoped to the coordination repo) in " +
        "the Cloudflare dashboard: Workers & Pages -> agentsync-remote -> " +
        "Settings -> Variables and Secrets.",
    );
    this.name = "GhPatMissingError";
  }
}

function ghHeaders(ctx: Ctx): Record<string, string> {
  if (!ctx.env.GH_PAT) throw new GhPatMissingError();
  return {
    Authorization: `Bearer ${ctx.env.GH_PAT}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "agentsync-remote",
  };
}

// UTF-8-safe base64 (GitHub contents are base64 of the raw file bytes).
export function b64encode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decode(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function contentsUrl(ctx: Ctx, path: string): string {
  const encoded = path
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${API}/repos/${ctx.repo}/contents/${encoded}`;
}

export interface ContentResult {
  content: string; // decoded UTF-8
  sha: string;
}

/** GET a file's decoded content + blob sha, or null if the file (or branch)
 *  does not exist (404). */
export async function getContent(
  ctx: Ctx,
  path: string,
  ref: string,
): Promise<ContentResult | null> {
  const url = `${contentsUrl(ctx, path)}?ref=${encodeURIComponent(ref)}`;
  const res = await fetch(url, { headers: ghHeaders(ctx) });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub GET contents failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { content: string; sha: string };
  return { content: b64decode(json.content), sha: json.sha };
}

export interface PutResult {
  status: number;
  ok: boolean;
  conflict: boolean; // HTTP 409 -- stale sha, CAS lost the race
  sha?: string; // new blob sha on success
}

/** PUT a file with compare-and-swap semantics. Pass `sha` to update an existing
 *  file (409 if stale); omit `sha` to create a new file. */
export async function putContent(
  ctx: Ctx,
  path: string,
  opts: { message: string; content: string; branch: string; sha?: string },
): Promise<PutResult> {
  const body: Record<string, unknown> = {
    message: opts.message,
    content: b64encode(opts.content),
    branch: opts.branch,
  };
  if (opts.sha) body.sha = opts.sha;

  const res = await fetch(contentsUrl(ctx, path), {
    method: "PUT",
    headers: { ...ghHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 409) return { status: 409, ok: false, conflict: true };
  if (!res.ok) {
    throw new Error(`GitHub PUT contents failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { content?: { sha?: string } };
  return { status: res.status, ok: true, conflict: false, sha: json.content?.sha };
}

/** The repository's default branch name. */
export async function getDefaultBranch(ctx: Ctx): Promise<string> {
  const res = await fetch(`${API}/repos/${ctx.repo}`, { headers: ghHeaders(ctx) });
  if (!res.ok) {
    throw new Error(`GitHub GET repo failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { default_branch: string };
  return json.default_branch;
}

/** The commit sha a branch points at, or null if the branch does not exist. */
export async function getBranchSha(ctx: Ctx, branch: string): Promise<string | null> {
  const res = await fetch(
    `${API}/repos/${ctx.repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    { headers: ghHeaders(ctx) },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub GET ref failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as { object: { sha: string } };
  return json.object.sha;
}

/** Create a new branch pointing at `fromSha`. */
export async function createBranch(
  ctx: Ctx,
  branch: string,
  fromSha: string,
): Promise<void> {
  const res = await fetch(`${API}/repos/${ctx.repo}/git/refs`, {
    method: "POST",
    headers: { ...ghHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
  });
  if (!res.ok) {
    throw new Error(`GitHub POST ref failed (${res.status}): ${await res.text()}`);
  }
}

export interface CommitSummary {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
}

/** Recent commits on a branch, newest first. */
export async function listCommits(
  ctx: Ctx,
  branch: string,
  limit: number,
): Promise<CommitSummary[]> {
  const url =
    `${API}/repos/${ctx.repo}/commits` +
    `?sha=${encodeURIComponent(branch)}&per_page=${Math.max(1, Math.min(100, limit))}`;
  const res = await fetch(url, { headers: ghHeaders(ctx) });
  if (!res.ok) {
    throw new Error(`GitHub GET commits failed (${res.status}): ${await res.text()}`);
  }
  const json = (await res.json()) as Array<{
    sha: string;
    commit: { message: string; author?: { name?: string; date?: string } };
  }>;
  return json.map((c) => ({
    sha: c.sha,
    message: c.commit.message,
    author: c.commit.author?.name ?? null,
    date: c.commit.author?.date ?? null,
  }));
}
