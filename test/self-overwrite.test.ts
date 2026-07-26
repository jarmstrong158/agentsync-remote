// claim() must not let an agent SILENTLY replace its own active claim.
//
// Claims are keyed by agent_id alone (`doc.claims[ctx.agentId] = entry`), so a
// second claim under the same id overwrites the first with no signal. One human
// running concurrent sessions shares an agent_id, so a session on project B
// evicts project A's claim — and A's later release()/finish() then closes B's.
// That happened in practice: a balatron claim was replaced by a meristem claim,
// and the subsequent release() closed the meristem one.
//
// The pre-existing duplicate-agent warning cannot catch this, because concurrent
// sessions can carry the same `instance` token (see the same-instance test).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { claim } from "../src/tools.js";
import { fakeGitHub, testCtx } from "./helpers.js";
import type { ClaimEntry } from "../src/types.js";

function entry(over: Partial<ClaimEntry> = {}): ClaimEntry {
  return {
    task: "project A",
    touches: ["projA/src/thing.ts"],
    requires: [],
    branch: "main",
    status: "in-progress",
    updated_at: "2026-01-01T00:00:00.000Z",
    instance: "shared-token",
    note: null,
    ...over,
  };
}

describe("claim() self-overwrite guard", () => {
  beforeEach(() => vi.unstubAllGlobals());

  it("BLOCKS an unrelated claim over my own active claim", async () => {
    const fake = fakeGitHub({ claims: { "jonny-mobile": entry() } });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await claim(testCtx(), {
      task: "project B",
      touches: ["projB/src/other.ts"],
    });

    expect(res.status).toBe("blocked");
    expect(res.existing_claim.task).toBe("project A");
    // and the board is untouched — the old claim survives
    expect(fake.state.file?.obj.claims["jonny-mobile"].task).toBe("project A");
  });

  it("ALLOWS widening my own scope (shared file) — the legitimate case", async () => {
    const fake = fakeGitHub({ claims: { "jonny-mobile": entry() } });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await claim(testCtx(), {
      task: "project A, wider",
      touches: ["projA/src/thing.ts", "projA/src/extra.ts"],
    });

    expect(res.status).toBe("claimed");
    expect(fake.state.file?.obj.claims["jonny-mobile"].touches).toHaveLength(2);
  });

  it("ALLOWS replacing a DONE claim — the normal finish-then-next flow", async () => {
    const fake = fakeGitHub({
      claims: { "jonny-mobile": entry({ status: "done" }) },
    });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await claim(testCtx(), {
      task: "next thing",
      touches: ["somewhere/else.ts"],
    });

    expect(res.status).toBe("claimed");
    expect(fake.state.file?.obj.claims["jonny-mobile"].task).toBe("next thing");
  });

  it("force=true still abandons the old claim deliberately", async () => {
    const fake = fakeGitHub({ claims: { "jonny-mobile": entry() } });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await claim(testCtx(), {
      task: "project B",
      touches: ["projB/src/other.ts"],
      force: true,
    });

    expect(res.status).toBe("claimed");
    expect(fake.state.file?.obj.claims["jonny-mobile"].task).toBe("project B");
  });

  it("a first-ever claim is unaffected (no existing entry)", async () => {
    const fake = fakeGitHub({ claims: {} });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await claim(testCtx(), { task: "first", touches: ["a.ts"] });
    expect(res.status).toBe("claimed");
  });

  it("an existing claim with empty touches cannot block (no overlap is knowable)", async () => {
    const fake = fakeGitHub({ claims: { "jonny-mobile": entry({ touches: [] }) } });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await claim(testCtx(), { task: "B", touches: ["b.ts"] });
    expect(res.status).toBe("claimed");
  });

  it("the same instance token does NOT excuse the overwrite", async () => {
    // This is precisely why the guard is needed: the duplicate-agent warning
    // keys off `existing.instance !== ctx.instance`, so when two concurrent
    // sessions share an instance token it never fires.
    const fake = fakeGitHub({
      claims: { "jonny-mobile": entry({ instance: "same-token" }) },
    });
    vi.stubGlobal("fetch", fake.fetch);

    const res: any = await claim(testCtx({}, { instance: "same-token" }), {
      task: "project B",
      touches: ["projB/src/other.ts"],
    });

    expect(res.status).toBe("blocked");
  });
});
