import { afterEach, describe, expect, it, vi } from "vitest";
import { claim, survey } from "../src/tools.js";
import { fakeGitHub, testCtx } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

// The one-click "Deploy to Cloudflare" flow drops a fresh Worker in front of a
// repo that may have NO coordination branch and NO claims.json yet -- the
// stateless analogue of "a cold, empty database". This proves the whole
// lifecycle works from that cold state with zero manual setup: no branch to
// pre-create, no file to seed, no SQL to run. If bootstrap ever regresses, a
// fresh self-hosted deploy would break on first use; this test catches that.

describe("cold start: fresh deploy against an empty repo", () => {
  it("provisions the branch + file and runs survey -> claim -> survey with no manual setup", async () => {
    // Empty repo: only the default branch exists. No agentsync branch, no file.
    const fake = fakeGitHub({ fileExists: false, defaultBranch: "main" });
    vi.stubGlobal("fetch", fake.fetch);

    // 1) First read on a cold repo returns an (initialized) empty board.
    const first: any = await survey(testCtx());
    expect(first.claims).toEqual({});
    expect(first.active_count).toBe(0);

    // The coordination branch and file now exist -- provisioned automatically.
    expect(fake.state.branches.has("agentsync")).toBe(true);
    expect(fake.state.file?.obj).toEqual({ claims: {} });
    expect(fake.state.commits.map((c) => c.message)).toContain(
      "agentsync: initialize claims.json",
    );

    // 2) A claim lands on top of the freshly provisioned file.
    const claimed: any = await claim(testCtx(), {
      task: "first work on a brand-new mesh",
      touches: ["src/api"],
      branch: "feature/api",
    });
    expect(claimed.status).toBe("claimed");

    // 3) A subsequent survey sees it -- full round trip from cold.
    const after: any = await survey(testCtx());
    expect(after.claims["jonny-mobile"].task).toBe("first work on a brand-new mesh");
    expect(after.active_count).toBe(1);

    // The written file is byte-shape-identical to local agentsync (no `notes`
    // key when there's no mailbox activity).
    expect(Object.keys(fake.state.file!.obj)).toEqual(["claims"]);
  });
});
