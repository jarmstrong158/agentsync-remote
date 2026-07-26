// Regression tests for the audit sweep. Each block names the thing that was
// actually wrong, because the failure modes here were all "looks fine, isn't".

import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { createMcpHandler } from "../src/mcp.js";
import { computeOverlap, fnmatch, pathsOverlap } from "../src/overlap.js";
import { MAX_MAILBOX_NOTES, mailbox } from "../src/tools.js";

import type { Env } from "../src/types.js";
import { fakeGitHub, testCtx } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const handler = createMcpHandler();

const req = (body: unknown) =>
  new Request("https://w.example/mcp/secret", { method: "POST", body: JSON.stringify(body) });

const call = async (name: string, args: unknown, ctx = testCtx()) => {
  const res = await handler(
    req({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    ctx,
  );
  return (await res.json()) as any;
};

// ---------------------------------------------------------------------------
// 1. The advertised inputSchema is now ENFORCED.
// ---------------------------------------------------------------------------

describe("runtime argument validation", () => {
  it("rejects the type confusion that used to reach computeOverlap", async () => {
    // claim({task: 123, touches: "src/api"}) previously sailed through
    // `args.touches ?? []` (a string is not nullish) into computeOverlap, which
    // iterated it CHARACTER BY CHARACTER and then wrote a schema-violating
    // ClaimEntry into the claims.json the local Python peer also reads.
    const fake = fakeGitHub({ claims: {} });
    vi.stubGlobal("fetch", fake.fetch);

    const json = await call("claim", { task: 123, touches: "src/api" });

    expect(json.error.code).toBe(-32602);
    expect(json.error.message).toMatch(/task: expected string, got integer/);
    expect(json.error.message).toMatch(/touches: expected array, got string/);
    // Crucially: nothing was written to the shared file.
    expect(fake.state.putCount).toBe(0);
  });

  it("rejects unknown properties and out-of-enum values", async () => {
    const bogus = await call("claim", { task: "t", touches: ["src/a"], nope: 1 });
    expect(bogus.error.message).toMatch(/nope: unexpected property/);

    const badEnum = await call("update_status", { status: "sideways" });
    expect(badEnum.error.message).toMatch(/must be one of/);
  });

  it("reports a missing required argument instead of writing a partial claim", async () => {
    const fake = fakeGitHub({ claims: {} });
    vi.stubGlobal("fetch", fake.fetch);
    const json = await call("claim", { touches: ["src/a"] });
    expect(json.error.message).toMatch(/task: required/);
    expect(fake.state.putCount).toBe(0);
  });

  it("enforces the cardinality caps that keep claims.json bounded", async () => {
    const tooMany = await call("claim", {
      task: "t",
      touches: Array.from({ length: 65 }, (_, i) => `src/f${i}`),
    });
    expect(tooMany.error.message).toMatch(/at most 64 items/);

    const tooLong = await call("claim", { task: "t", touches: ["x".repeat(257)] });
    expect(tooLong.error.message).toMatch(/at most 256 characters/);
  });

  it("still accepts a well-formed call", async () => {
    const fake = fakeGitHub({ claims: {} });
    vi.stubGlobal("fetch", fake.fetch);
    const json = await call("claim", { task: "real work", touches: ["src/api"] });
    expect(json.error).toBeUndefined();
    expect(json.result.isError).toBe(false);
    expect(JSON.parse(json.result.content[0].text).status).toBe("claimed");
  });
});

// ---------------------------------------------------------------------------
// 2. The ReDoS primitive is gone.
// ---------------------------------------------------------------------------

describe("glob matching is not a ReDoS primitive", () => {
  it("resolves the catastrophic-backtracking pattern in milliseconds", () => {
    // Under the old `new RegExp("^" + re + "$")` this became
    // /^a.*a.*a.*a.*a.*a.*a.*a.*a.*b$/ against a non-matching subject, i.e.
    // exponential backtracking -- re-run on every one of the 5 CAS retries.
    const evil = "a*a*a*a*a*a*a*a*a*b";
    const victim = "a".repeat(200);

    const started = Date.now();
    const result = pathsOverlap(evil, victim);
    const elapsed = Date.now() - started;

    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(500);
  });

  it("stays bounded across a full peer set, in both directions", () => {
    const evil = ["a*a*a*a*a*a*a*a*a*b", "*a*a*a*a*a*a*a*a*a*a*"];
    const peers = Array.from({ length: 50 }, (_, i) => `${"a".repeat(120)}/file${i}.ts`);

    const started = Date.now();
    computeOverlap(evil, peers);
    computeOverlap(peers, evil);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("collapses runs of '*', which is both correct fnmatch and cheaper", () => {
    // '**' means exactly what '*' means in fnmatch, so a run costs one token
    // rather than one per character.
    expect(fnmatch("*".repeat(40) + "b", "aaab")).toBe(true);
    expect(fnmatch("a**b", "axxxb")).toBe(true);
  });

  it("caps pattern length and complexity, failing safe (no match, no throw)", () => {
    // Over-cap patterns must not glob-match. Failing SAFE rather than open
    // matters: a hostile pattern must never be able to WIDEN a claim either.
    // Over MAX_PATTERN_LENGTH (256):
    expect(fnmatch("a*".repeat(200), "a".repeat(300))).toBe(false);
    // Over MAX_PATTERN_TOKENS (64 wildcards) while under the length cap:
    expect(fnmatch("a?".repeat(70), "a".repeat(140))).toBe(false);
    // Malformed input never throws.
    expect(() => fnmatch("[".repeat(300), "x")).not.toThrow();
    expect(() => fnmatch("[a-", "x")).not.toThrow();
  });

  it("preserves the fnmatch semantics local agentsync relies on", () => {
    // Behaviour parity with the regex version it replaced -- '*' is NOT special
    // about '/', matching Python's fnmatch.
    expect(fnmatch("src/**", "src/api")).toBe(true);
    expect(fnmatch("src/*", "src/a/b/c.py")).toBe(true);
    expect(fnmatch("*.py", "main.py")).toBe(true);
    expect(fnmatch("*.py", "main.ts")).toBe(false);
    expect(fnmatch("src/?.py", "src/a.py")).toBe(true);
    expect(fnmatch("src/?.py", "src/ab.py")).toBe(false);
    expect(fnmatch("src/[abc].py", "src/b.py")).toBe(true);
    expect(fnmatch("src/[!abc].py", "src/b.py")).toBe(false);
    expect(fnmatch("src/[!abc].py", "src/z.py")).toBe(true);
    expect(fnmatch("src/[a-c].py", "src/b.py")).toBe(true);
    expect(fnmatch("src/[a-c].py", "src/z.py")).toBe(false);
    // An unterminated '[' is a literal, as before.
    expect(fnmatch("src/[.py", "src/[.py")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. retry_exhausted no longer masquerades as success.
// ---------------------------------------------------------------------------

describe("retry exhaustion surfaces as isError", () => {
  it("does not hand a model a success-shaped result for a claim that never landed", async () => {
    const fake = fakeGitHub({
      claims: {},
      beforePut(state) {
        state.file = { obj: state.file!.obj, sha: `sha-${state.shaCounter++}` };
      },
    });
    vi.stubGlobal("fetch", fake.fetch);

    const json = await call("claim", { task: "t", touches: ["src/api"] });

    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/Nothing was written/);
  });
});

// ---------------------------------------------------------------------------
// 4. protocolVersion is validated, not echoed.
// ---------------------------------------------------------------------------

describe("protocol negotiation", () => {
  const initialize = async (protocolVersion?: unknown) => {
    const res = await handler(
      req({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion } }),
      testCtx(),
    );
    return (await res.json()) as any;
  };

  it("does not echo an unsupported version back", async () => {
    const json = await initialize("banana");
    expect(json.result.protocolVersion).not.toBe("banana");
    expect(json.result.protocolVersion).toBe("2025-06-18");
  });

  it("agrees to a supported older revision", async () => {
    expect((await initialize("2024-11-05")).result.protocolVersion).toBe("2024-11-05");
  });

  it("falls back to the pinned version when none is requested or it is not a string", async () => {
    expect((await initialize(undefined)).result.protocolVersion).toBe("2025-06-18");
    expect((await initialize(42)).result.protocolVersion).toBe("2025-06-18");
  });
});

// ---------------------------------------------------------------------------
// 5. Token comparison: shared, decoding, and fail-closed.
// ---------------------------------------------------------------------------

const ENV: Env = {
  AUTH_TOKEN: "secret",
  GH_PAT: "ghp_test",
  REPO: "owner/repo",
  AGENT_ID: "jonny-mobile",
  BRANCH: "agentsync",
  CLAIMS_PATH: "claims.json",
};

const ping = (token: string, env: Env = ENV) =>
  worker.fetch(
    new Request(`https://w.example/mcp/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }),
    env,
  );

describe("path-token auth", () => {
  it("percent-decodes the segment, matching the sibling Workers", async () => {
    // This Worker did NOT decode before the shared core landed, so a token
    // containing a URL-escaped character authenticated against
    // context-keeper-remote and 404'd here -- the exact drift the shared module
    // exists to prevent. '+' must stay a literal '+' (this is a path segment,
    // not a query string), and the raw undecoded form must NOT authenticate.
    const env = { ...ENV, AUTH_TOKEN: "a b+c" };
    expect((await ping("a%20b%2Bc", env)).status).toBe(200);
    expect((await ping("a+b+c", env)).status).toBe(404);
  });

  it("does not 500 on a malformed percent-escape", async () => {
    // decodeURIComponent("%zz") throws URIError. In context-keeper-remote that
    // call sat OUTSIDE the request try/catch and became an uncaught 500, which
    // is also an oracle: 500 means "path matched, token didn't decode".
    const res = await ping("%zz");
    expect(res.status).toBe(404);
  });

  it("rejects an absurdly long token without comparing it", async () => {
    expect((await ping("x".repeat(5000))).status).toBe(404);
  });

  it("still fails closed when AUTH_TOKEN is unset or empty", async () => {
    expect((await ping("secret", { ...ENV, AUTH_TOKEN: undefined })).status).toBe(404);
    expect((await ping("", { ...ENV, AUTH_TOKEN: "" })).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 6. Envelope limits.
// ---------------------------------------------------------------------------

describe("request limits", () => {
  it("rejects an oversized batch rather than fanning it out to GitHub", async () => {
    const batch = Array.from({ length: 65 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "ping",
    }));
    const res = await handler(req(batch), testCtx());
    const json = (await res.json()) as any;
    expect(json.error.message).toMatch(/Batch too large/);
  });

  it("rejects an oversized body", async () => {
    const res = await handler(
      new Request("https://w.example/mcp/secret", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", pad: "x".repeat(1_100_000) }),
      }),
      testCtx(),
    );
    const json = (await res.json()) as any;
    expect(json.error.message).toMatch(/too large/);
  });

  it("bounds mailbox growth in the shared coordination file", async () => {
    // claims.json is not a log: every peer, local and remote, fetches and
    // parses it on EVERY survey/claim/release, so unbounded notes tax every
    // operation the mesh performs. Oldest-first eviction keeps the channel
    // useful (a question just asked is the one that matters).
    const notes = Array.from({ length: MAX_MAILBOX_NOTES }, (_, i) => ({
      from: "peer",
      to: null,
      message: `old ${i}`,
      at: "2026-01-01T00:00:00.000Z",
    }));
    const fake = fakeGitHub({ claims: {}, notes });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await mailbox(testCtx(), { message: "the newest question" });

    expect(res.notes.length).toBe(MAX_MAILBOX_NOTES);
    expect(res.dropped_oldest).toBe(1);
    expect(res.retention).toMatch(/git history/);
    // The oldest went, the newest stayed.
    expect(res.notes[0].message).toBe("old 1");
    expect(res.notes[MAX_MAILBOX_NOTES - 1].message).toBe("the newest question");
    expect(fake.state.file!.obj.notes!.length).toBe(MAX_MAILBOX_NOTES);
  });

  it("leaves a small mailbox untouched and reports no eviction", async () => {
    const fake = fakeGitHub({ claims: {}, notes: [] });
    vi.stubGlobal("fetch", fake.fetch);
    const res: any = await mailbox(testCtx(), { message: "hello" });
    expect(res.notes.length).toBe(1);
    expect(res.dropped_oldest).toBeUndefined();
  });

  it("still handles a normal batch", async () => {
    const res = await handler(
      req([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
      ]),
      testCtx(),
    );
    expect(((await res.json()) as any[]).length).toBe(2);
  });
});
