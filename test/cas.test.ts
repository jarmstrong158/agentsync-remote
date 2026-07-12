import { afterEach, describe, expect, it, vi } from "vitest";
import { claim, survey } from "../src/tools.js";
import { fakeGitHub, makeClaim, testCtx } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("claim() happy path", () => {
  it("writes an entry with the exact contract shape and commit message", async () => {
    const fake = fakeGitHub({ claims: {} });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await claim(testCtx(), {
      task: "wire up api",
      touches: ["src/api"],
      requires: [],
      branch: "feature/api",
    });

    expect(res.status).toBe("claimed");
    expect(res.claim).toEqual({
      task: "wire up api",
      touches: ["src/api"],
      requires: [],
      branch: "feature/api",
      status: "in-progress",
      updated_at: "2026-07-08T00:00:00.000Z",
      instance: "mobile-instance",
      note: null,
    });
    // Peer entry persisted under the agent id.
    expect(fake.state.file?.obj.claims["jonny-mobile"].task).toBe("wire up api");
    // Commit message interleaves with local peers.
    expect(fake.state.commits[0].message).toBe(
      "agentsync: jonny-mobile claims 'wire up api'",
    );
  });

  it("defaults an omitted branch to a clear placeholder", async () => {
    const fake = fakeGitHub({ claims: {} });
    vi.stubGlobal("fetch", fake.fetch);
    const res: any = await claim(testCtx(), { task: "t", touches: ["a"] });
    expect(res.claim.branch).toBe("(unspecified)");
  });
});

describe("409 CAS -> blocked (forced rejection analogue)", () => {
  it("first PUT 409s, re-GET shows a peer's new overlapping claim -> blocked", async () => {
    let raced = false;
    const fake = fakeGitHub({
      claims: {},
      beforePut(state) {
        if (raced) return;
        raced = true;
        // A peer commits an overlapping claim between our GET and our PUT.
        state.file = {
          obj: { claims: { peer: makeClaim({ task: "their api", branch: "b", touches: ["src/api/routes.py"] }) } },
          sha: `sha-${state.shaCounter++}`,
        };
      },
    });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await claim(testCtx(), { task: "my api", touches: ["src/api"] });

    expect(res.status).toBe("blocked");
    expect(res.message).toMatch(/Narrow `touches`/);
    expect(res.conflicts.peer.their_task).toBe("their api");
    expect(res.conflicts.peer.reasons).toEqual([
      { type: "shared_files", files: ["src/api/routes.py"] },
    ]);
    // We never overwrote the peer's entry.
    expect(fake.state.file?.obj.claims["jonny-mobile"]).toBeUndefined();
    expect(fake.state.file?.obj.claims.peer).toBeDefined();
  });
});

describe("409 CAS -> retry succeeds, peer entry survives", () => {
  it("non-overlapping peer race: retry lands, both entries present", async () => {
    let raced = false;
    const fake = fakeGitHub({
      claims: {},
      beforePut(state) {
        if (raced) return;
        raced = true;
        // A peer commits a NON-overlapping claim, forcing a 409 on our PUT.
        state.file = {
          obj: { claims: { peer: makeClaim({ task: "docs", branch: "b", touches: ["docs/guide.md"] }) } },
          sha: `sha-${state.shaCounter++}`,
        };
      },
    });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await claim(testCtx(), { task: "api work", touches: ["src/api"] });

    expect(res.status).toBe("claimed");
    // Both the peer's entry and ours survive in the written JSON.
    const written = fake.state.file!.obj.claims;
    expect(written.peer.task).toBe("docs");
    expect(written["jonny-mobile"].task).toBe("api work");
    expect(fake.state.putCount).toBe(2); // one 409, one success
  });
});

describe("PUSH_RETRIES exhaustion", () => {
  it("every PUT 409s -> retry_exhausted shape", async () => {
    const fake = fakeGitHub({
      claims: {},
      beforePut(state) {
        // Always race: bump the sha before every PUT so our sha is always stale.
        // Non-overlapping, so overlap re-check passes each attempt.
        state.file = {
          obj: state.file!.obj,
          sha: `sha-${state.shaCounter++}`,
        };
      },
    });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await claim(testCtx(), { task: "t", touches: ["src/api"] });

    expect(res).toEqual({
      status: "retry_exhausted",
      message: "Push kept losing the race; call survey() and try again.",
    });
    expect(fake.state.putCount).toBe(5); // PUSH_RETRIES
  });
});

describe("branch/file bootstrap when missing", () => {
  it("creates the branch and initializes {claims:{}} then claims", async () => {
    // No coordination branch, no file. Only the default branch exists.
    const fake = fakeGitHub({ fileExists: false, defaultBranch: "main" });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await claim(testCtx(), { task: "first", touches: ["a"] });

    expect(res.status).toBe("claimed");
    expect(fake.state.branches.has("agentsync")).toBe(true);
    expect(fake.state.file?.obj.claims["jonny-mobile"].task).toBe("first");
    // The initialize commit ran before the claim commit.
    const messages = fake.state.commits.map((c) => c.message);
    expect(messages).toContain("agentsync: initialize claims.json");
  });

  it("survey on an empty repo initializes and returns empty claims", async () => {
    const fake = fakeGitHub({ fileExists: false });
    vi.stubGlobal("fetch", fake.fetch);
    const res: any = await survey(testCtx());
    expect(res.claims).toEqual({});
    expect(res.active_count).toBe(0);
  });
});

describe("422 on first create -> retry succeeds", () => {
  it("no-sha create races an already-created file (422) -> loop re-fetches and lands", async () => {
    // Cold repo: no coordination branch, no file. The first-ever write is a
    // no-sha create. A peer creates claims.json in the same window, so GitHub
    // answers our create with 422 ("sha wasn't supplied"), not 409. The loop
    // must treat that as a conflict, re-fetch the now-existing sha, and retry.
    let raced = false;
    const fake = fakeGitHub({
      fileExists: false,
      defaultBranch: "main",
      beforePut(state) {
        if (raced) return;
        raced = true;
        // A peer wins the create race between our bootstrap and our PUT.
        state.file = { obj: { claims: {} }, sha: `sha-${state.shaCounter++}` };
      },
    });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await claim(testCtx(), { task: "first", touches: ["src/api"] });

    expect(res.status).toBe("claimed");
    expect(res.claim.task).toBe("first");
    // One rejected create (422) + one successful update.
    expect(fake.state.putCount).toBe(2);
    expect(fake.state.file?.obj.claims["jonny-mobile"].task).toBe("first");
  });
});

describe("duplicate-instance warning", () => {
  it("warns when an existing claim carries a different instance token", async () => {
    const fake = fakeGitHub({
      claims: {
        "jonny-mobile": makeClaim({ task: "old", instance: "some-other-instance" }),
      },
    });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await claim(testCtx(), { task: "new", touches: ["a"] });

    expect(res.status).toBe("claimed");
    expect(res.warning).toMatch(/already holds agent_id 'jonny-mobile'/);
    expect(res.warning).toMatch(/some-other-instance/);
  });

  it("no warning when the instance matches", async () => {
    const fake = fakeGitHub({
      claims: {
        "jonny-mobile": makeClaim({ task: "old", instance: "mobile-instance" }),
      },
    });
    vi.stubGlobal("fetch", fake.fetch);
    const res: any = await claim(testCtx(), { task: "new", touches: ["a"] });
    expect(res.warning).toBeUndefined();
  });
});

describe("force bypasses overlap", () => {
  it("claims over an overlapping active peer when force=true", async () => {
    const fake = fakeGitHub({
      claims: { peer: makeClaim({ touches: ["src/api"] }) },
    });
    vi.stubGlobal("fetch", fake.fetch);
    const res: any = await claim(testCtx(), {
      task: "override",
      touches: ["src/api"],
      force: true,
    });
    expect(res.status).toBe("claimed");
    expect(fake.state.file?.obj.claims.peer).toBeDefined();
  });
});
