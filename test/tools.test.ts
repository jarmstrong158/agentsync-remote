import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkConflicts,
  claim,
  history,
  mailbox,
  release,
  updateStatus,
} from "../src/tools.js";
import { GhPatMissingError, b64decode } from "../src/github.js";
import { fakeGitHub, makeClaim, testCtx } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("mailbox round-trip", () => {
  it("posts a note and reads it back; note survives in the file", async () => {
    const fake = fakeGitHub({ claims: {} });
    vi.stubGlobal("fetch", fake.fetch);

    const posted: any = await mailbox(testCtx(), {
      message: "Should I use the v2 endpoint?",
      to: "desktop-agent",
    });
    expect(posted.status).toBe("posted");
    expect(posted.note).toEqual({
      from: "jonny-mobile",
      to: "desktop-agent",
      message: "Should I use the v2 endpoint?",
      at: "2026-07-08T00:00:00.000Z",
    });
    expect(fake.state.commits[0].message).toBe("agentsync: jonny-mobile posts a note");

    const read: any = await mailbox(testCtx());
    expect(read.status).toBe("read");
    expect(read.notes).toHaveLength(1);
    expect(read.notes[0].message).toBe("Should I use the v2 endpoint?");
  });

  it("reading an empty mailbox does not write", async () => {
    const fake = fakeGitHub({ claims: {} });
    vi.stubGlobal("fetch", fake.fetch);
    const read: any = await mailbox(testCtx());
    expect(read.notes).toEqual([]);
    expect(fake.state.putCount).toBe(0);
  });

  it("notes key is only written when notes exist (local-compat)", async () => {
    const fake = fakeGitHub({ claims: {} });
    vi.stubGlobal("fetch", fake.fetch);
    await claim(testCtx(), { task: "t", touches: ["a"] });
    // No notes yet -> serialized file must not carry a `notes` key.
    const body = fake.state.putBodies.at(-1) as any;
    const written = JSON.parse(b64decode(body.content));
    expect(written).not.toHaveProperty("notes");
    expect(Object.keys(written)).toEqual(["claims"]);
  });
});

describe("update_status", () => {
  it("changes status and note with the matching commit message", async () => {
    const fake = fakeGitHub({ claims: { "jonny-mobile": makeClaim() } });
    vi.stubGlobal("fetch", fake.fetch);
    const res: any = await updateStatus(testCtx(), { status: "planning", note: "regrouping" });
    expect(res.status).toBe("updated");
    expect(res.claim.status).toBe("planning");
    expect(res.claim.note).toBe("regrouping");
    expect(fake.state.commits[0].message).toBe(
      "agentsync: jonny-mobile updates status to 'planning'",
    );
  });

  it("rejects an invalid status", async () => {
    const fake = fakeGitHub({ claims: { "jonny-mobile": makeClaim() } });
    vi.stubGlobal("fetch", fake.fetch);
    const res: any = await updateStatus(testCtx(), { status: "bogus" as any });
    expect(res.status).toBe("error");
  });

  it("reports no_claim when there is nothing to update", async () => {
    const fake = fakeGitHub({ claims: {} });
    vi.stubGlobal("fetch", fake.fetch);
    const res: any = await updateStatus(testCtx(), { status: "done" });
    expect(res.status).toBe("no_claim");
  });
});

describe("release", () => {
  it("marks the claim done (done never blocks) with a closing note", async () => {
    const fake = fakeGitHub({ claims: { "jonny-mobile": makeClaim() } });
    vi.stubGlobal("fetch", fake.fetch);
    const res: any = await release(testCtx(), { note: "shipped" });
    expect(res.status).toBe("released");
    expect(res.claim.status).toBe("done");
    expect(res.claim.note).toBe("shipped");
    expect(fake.state.commits[0].message).toMatch(/^agentsync: jonny-mobile releases '/);
  });
});

describe("check_conflicts", () => {
  it("reports conflicts against my current claim", async () => {
    const fake = fakeGitHub({
      claims: {
        "jonny-mobile": makeClaim({ touches: ["src/api"] }),
        peer: makeClaim({ task: "P", branch: "pb", touches: ["src/api/routes.py"] }),
      },
    });
    vi.stubGlobal("fetch", fake.fetch);
    const res: any = await checkConflicts(testCtx());
    expect(res.status).toBe("conflicts");
    expect(res.conflicts.peer.their_task).toBe("P");
  });

  it("filters by against_branch", async () => {
    const fake = fakeGitHub({
      claims: {
        "jonny-mobile": makeClaim({ touches: ["src/api"] }),
        onbranch: makeClaim({ branch: "target", touches: ["src/api"] }),
        offbranch: makeClaim({ branch: "other", touches: ["src/api"] }),
      },
    });
    vi.stubGlobal("fetch", fake.fetch);
    const res: any = await checkConflicts(testCtx(), { against_branch: "target" });
    expect(Object.keys(res.conflicts)).toEqual(["onbranch"]);
  });

  it("returns no_claim when I have no claim", async () => {
    const fake = fakeGitHub({ claims: {} });
    vi.stubGlobal("fetch", fake.fetch);
    const res: any = await checkConflicts(testCtx());
    expect(res.status).toBe("no_claim");
  });
});

describe("history", () => {
  it("returns recent coordination-branch commits", async () => {
    const fake = fakeGitHub({
      claims: {},
      commits: [
        { sha: "abcdef1234", message: "agentsync: laptop claims 'x'", author: "L", date: "d1" },
        { sha: "1234567890", message: "agentsync: jonny-mobile claims 'y'", author: "M", date: "d2" },
      ],
    });
    vi.stubGlobal("fetch", fake.fetch);
    const res: any = await history(testCtx(), { limit: 5 });
    expect(res.commits).toHaveLength(2);
    expect(res.commits[0]).toEqual({
      sha: "abcdef1",
      message: "agentsync: laptop claims 'x'",
      author: "L",
      date: "d1",
    });
  });
});

describe("missing GH_PAT", () => {
  it("throws a named, actionable error before any network call", async () => {
    // No fetch stubbed: if the code reached fetch, the test would surface it.
    const ctx = testCtx({ GH_PAT: undefined });
    await expect(claim(ctx, { task: "t", touches: ["a"] })).rejects.toBeInstanceOf(
      GhPatMissingError,
    );
  });
});
