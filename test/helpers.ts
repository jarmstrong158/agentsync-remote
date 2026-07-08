// An in-memory fake of the GitHub REST endpoints agentsync-remote uses, with
// real compare-and-swap semantics on the contents API. No network. Wire it in
// with `vi.stubGlobal("fetch", fake.fetch)`.

import { b64decode, b64encode } from "../src/github.js";
import { buildCtx } from "../src/tools.js";
import type { ClaimEntry, Ctx, Env, MailboxNote } from "../src/types.js";

const b64 = { encode: b64encode, decode: b64decode };

export interface FakeOpts {
  repo?: string;
  branch?: string;
  path?: string;
  claims?: Record<string, ClaimEntry>;
  notes?: MailboxNote[];
  fileExists?: boolean; // default true when claims/notes provided or explicitly set
  branches?: string[];
  defaultBranch?: string;
  commits?: Array<{ sha: string; message: string; author?: string; date?: string }>;
  // Runs before every PUT sha-check, letting a test simulate a peer committing
  // first (mutate state + bump sha to force a 409). Return value ignored.
  beforePut?: (state: FakeState) => void;
}

export interface FakeState {
  file: { obj: { claims: Record<string, ClaimEntry>; notes?: MailboxNote[] }; sha: string } | null;
  branches: Set<string>;
  defaultBranch: string;
  branchShas: Map<string, string>;
  commits: Array<{ sha: string; message: string; author?: string; date?: string }>;
  shaCounter: number;
  putCount: number;
  getContentCount: number;
  putBodies: Array<Record<string, unknown>>;
}

export interface Fake {
  fetch: typeof fetch;
  state: FakeState;
}

export function makeClaim(over: Partial<ClaimEntry> = {}): ClaimEntry {
  return {
    task: "t",
    touches: ["src/x"],
    requires: [],
    branch: "feature/x",
    status: "in-progress",
    updated_at: "2026-01-01T00:00:00.000Z",
    instance: "peer-instance",
    note: null,
    ...over,
  };
}

export function fakeGitHub(opts: FakeOpts = {}): Fake {
  const path = opts.path ?? "claims.json";
  const branch = opts.branch ?? "agentsync";

  const hasFile =
    opts.fileExists ?? (opts.claims !== undefined || opts.notes !== undefined);

  const state: FakeState = {
    file: null,
    branches: new Set(opts.branches ?? [opts.defaultBranch ?? "main"]),
    defaultBranch: opts.defaultBranch ?? "main",
    branchShas: new Map(),
    commits: opts.commits ? [...opts.commits] : [],
    shaCounter: 1,
    putCount: 0,
    getContentCount: 0,
    putBodies: [],
  };
  // The coordination branch is present unless the test is exercising bootstrap.
  if (hasFile) state.branches.add(branch);
  for (const b of state.branches) state.branchShas.set(b, `commit-${b}`);

  if (hasFile) {
    const obj: { claims: Record<string, ClaimEntry>; notes?: MailboxNote[] } = {
      claims: opts.claims ?? {},
    };
    if (opts.notes) obj.notes = opts.notes;
    state.file = { obj, sha: `sha-${state.shaCounter++}` };
  }

  const jsonRes = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const rawUrl = typeof input === "string" ? input : input.toString();
    const url = new URL(rawUrl);
    const method = (init.method ?? "GET").toUpperCase();
    const parts = url.pathname.split("/").filter(Boolean);
    // parts: ["repos", owner, repoName, ...rest]
    const rest = parts.slice(3);

    // GET /repos/{owner}/{repo}
    if (rest.length === 0 && method === "GET") {
      return jsonRes(200, { default_branch: state.defaultBranch });
    }

    // /repos/{owner}/{repo}/contents/{...path}
    if (rest[0] === "contents") {
      const reqPath = rest.slice(1).map(decodeURIComponent).join("/");
      if (reqPath !== path) return jsonRes(404, { message: "Not Found" });

      if (method === "GET") {
        state.getContentCount++;
        const ref = url.searchParams.get("ref");
        if (!state.branches.has(ref ?? "")) return jsonRes(404, { message: "Not Found (branch)" });
        if (!state.file) return jsonRes(404, { message: "Not Found (file)" });
        return jsonRes(200, {
          path,
          sha: state.file.sha,
          content: b64.encode(JSON.stringify(state.file.obj)),
        });
      }

      if (method === "PUT") {
        state.putCount++;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        state.putBodies.push(body);
        if (opts.beforePut) opts.beforePut(state);

        const incomingSha = body.sha as string | undefined;
        const currentSha = state.file?.sha;

        if (currentSha) {
          // Updating an existing file: sha must match current, else 409.
          if (incomingSha !== currentSha) {
            return jsonRes(409, { message: "does not match" });
          }
        } else {
          // Creating a new file: no sha expected.
          if (incomingSha) return jsonRes(409, { message: "sha on create" });
        }

        const newObj = JSON.parse(b64.decode(body.content as string));
        const newSha = `sha-${state.shaCounter++}`;
        state.file = { obj: newObj, sha: newSha };
        state.branches.add(body.branch as string);
        state.commits.unshift({
          sha: `commit-${newSha}`,
          message: String(body.message),
          author: "agentsync-remote",
          date: "2026-07-08T00:00:00.000Z",
        });
        return jsonRes(currentSha ? 200 : 201, {
          content: { path, sha: newSha },
          commit: { sha: `commit-${newSha}` },
        });
      }
    }

    // GET /repos/{owner}/{repo}/git/ref/heads/{branch}
    if (rest[0] === "git" && rest[1] === "ref" && rest[2] === "heads") {
      const b = rest.slice(3).map(decodeURIComponent).join("/");
      const sha = state.branchShas.get(b);
      if (!sha) return jsonRes(404, { message: "Not Found" });
      return jsonRes(200, { object: { sha } });
    }

    // POST /repos/{owner}/{repo}/git/refs
    if (rest[0] === "git" && rest[1] === "refs" && method === "POST") {
      const body = JSON.parse(String(init.body)) as { ref: string; sha: string };
      const b = body.ref.replace("refs/heads/", "");
      state.branches.add(b);
      state.branchShas.set(b, body.sha);
      return jsonRes(201, { ref: body.ref, object: { sha: body.sha } });
    }

    // GET /repos/{owner}/{repo}/commits
    if (rest[0] === "commits" && method === "GET") {
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      return jsonRes(
        200,
        state.commits.slice(0, perPage).map((c) => ({
          sha: c.sha,
          commit: {
            message: c.message,
            author: { name: c.author ?? null, date: c.date ?? null },
          },
        })),
      );
    }

    return jsonRes(404, { message: `Unhandled ${method} ${url.pathname}` });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, state };
}

/** A test ctx with a fixed clock, no-op sleep, and a fixed instance token. */
export function testCtx(over: Partial<Env> = {}, ctxOver: Partial<Pick<Ctx, "now" | "sleep" | "instance">> = {}): Ctx {
  const env: Env = {
    AUTH_TOKEN: "secret",
    GH_PAT: "ghp_test",
    REPO: "owner/repo",
    AGENT_ID: "jonny-mobile",
    BRANCH: "agentsync",
    CLAIMS_PATH: "claims.json",
    ...over,
  };
  return buildCtx(env, {
    now: () => "2026-07-08T00:00:00.000Z",
    sleep: async () => {},
    instance: "mobile-instance",
    ...ctxOver,
  });
}
