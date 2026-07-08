import { describe, expect, it, vi } from "vitest";
import { claim } from "../src/tools.js";
import { fakeGitHub, testCtx } from "./helpers.js";

// -------------------------------------------------------------------------
// Simulated-contention stress test for the claim() compare-and-swap loop.
//
// HONESTY LABEL: this is *simulated* contention. GitHub is replaced by an
// in-process fake that reproduces the one property the real coordination
// depends on -- the contents API's CAS: a PUT with a stale blob `sha` returns
// HTTP 409 (see test/helpers.ts). There is no network and no real GitHub here.
// What it does exercise for real is the Worker's own claim() CAS loop: two
// peers run concurrently against one shared file, their GET/PUT calls interleave
// under randomized microtask jitter, and every 409 drives a real re-read +
// overlap re-check + retry.
//
// Two safety properties are asserted across every single race:
//   * zero lost claims     -- a granted claim is always present in the final
//                             file; no peer's entry is ever overwritten.
//   * zero double-grants   -- two peers never both hold an overlapping claim;
//                             at most one wins, the other is cleanly blocked.
// Plus liveness: every race grants at least one claim (no mutual starvation).
// -------------------------------------------------------------------------

// Seeded PRNG (mulberry32) so the randomized interleavings are reproducible in
// CI while still varying across the N iterations.
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RACES = 1000; // a thousand independent two-peer races

describe("simulated contention: claim() CAS under randomized races", () => {
  it(`runs ${RACES} two-peer races with 0 lost claims and 0 double-grants`, async () => {
    const rng = mulberry32(0x5eed);

    let lostClaims = 0;
    let doubleGrants = 0;
    let overlapRaces = 0;
    let nonOverlapRaces = 0;
    let racesWith409 = 0;
    let total409 = 0;
    let racesWithAWinner = 0;

    for (let i = 0; i < RACES; i++) {
      const overlap = rng() < 0.5;

      // Peer A always touches src/api. Peer B touches an overlapping path
      // (directory containment) or a disjoint one, chosen at random.
      const aTouch = ["src/api"];
      const bTouch = overlap ? ["src/api/routes.ts"] : ["docs/guide.md"];

      const fake = fakeGitHub({ claims: {} });

      // Wrap the fake so each fetch is delayed a random number of microtasks:
      // this shuffles the order in which the two peers' GET/PUT calls land,
      // producing a different interleaving per race. Also count 409s to prove
      // the races were genuinely contended, not trivially serialized.
      let race409 = 0;
      const jittered = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const ticks = Math.floor(rng() * 5);
        for (let t = 0; t < ticks; t++) await Promise.resolve();
        const res = await (fake.fetch as any)(input, init);
        if (res.status === 409) {
          race409++;
          total409++;
        }
        return res;
      }) as unknown as typeof fetch;
      vi.stubGlobal("fetch", jittered);

      const ctxA = testCtx({ AGENT_ID: "peer-alpha" }, { instance: "inst-alpha" });
      const ctxB = testCtx({ AGENT_ID: "peer-beta" }, { instance: "inst-beta" });

      const callA = () =>
        claim(ctxA, { task: "alpha-work", touches: aTouch, branch: "feat/a" }) as Promise<any>;
      const callB = () =>
        claim(ctxB, { task: "beta-work", touches: bTouch, branch: "feat/b" }) as Promise<any>;

      // Randomize which peer's claim is launched first, then run concurrently.
      const [first, second] = rng() < 0.5 ? [callA, callB] : [callB, callA];
      const [r1, r2] = await Promise.all([first(), second()]);

      const finalClaims = fake.state.file!.obj.claims;
      const alphaClaimed = [r1, r2].some((r) => r.status === "claimed" && r.claim.task === "alpha-work");
      const betaClaimed = [r1, r2].some((r) => r.status === "claimed" && r.claim.task === "beta-work");
      const claimedCount = (alphaClaimed ? 1 : 0) + (betaClaimed ? 1 : 0);

      if (race409 > 0) racesWith409++;
      if (claimedCount >= 1) racesWithAWinner++;

      // --- Invariant 1: no lost claims. Every peer told "claimed" is present. ---
      if (alphaClaimed && finalClaims["peer-alpha"]?.task !== "alpha-work") lostClaims++;
      if (betaClaimed && finalClaims["peer-beta"]?.task !== "beta-work") lostClaims++;

      if (overlap) {
        overlapRaces++;
        // --- Invariant 2: no double-grant of overlapping work. ---
        if (alphaClaimed && betaClaimed) doubleGrants++;
        // Safety+liveness: exactly one winner; the loser is cleanly blocked.
        expect(claimedCount, `overlap race ${i}: expected exactly one winner`).toBe(1);
        const loser = [r1, r2].find((r) => r.status !== "claimed");
        expect(loser?.status, `overlap race ${i}: loser must be blocked`).toBe("blocked");
      } else {
        nonOverlapRaces++;
        // Disjoint work: both peers win and both entries coexist.
        expect(claimedCount, `disjoint race ${i}: both peers should win`).toBe(2);
        expect(finalClaims["peer-alpha"]?.task).toBe("alpha-work");
        expect(finalClaims["peer-beta"]?.task).toBe("beta-work");
      }

      vi.unstubAllGlobals();
    }

    // Headline reliability assertions across all races.
    expect(lostClaims, "lost claims across all races").toBe(0);
    expect(doubleGrants, "double-granted overlapping claims across all races").toBe(0);
    expect(racesWithAWinner, "every race must grant at least one claim").toBe(RACES);

    // Emit a summary the RELIABILITY doc can cite (visible with --reporter=verbose).
    // eslint-disable-next-line no-console
    console.log(
      `[stress-cas] races=${RACES} overlap=${overlapRaces} disjoint=${nonOverlapRaces} ` +
        `lostClaims=${lostClaims} doubleGrants=${doubleGrants} ` +
        `racesWith409=${racesWith409} total409=${total409}`,
    );

    // Sanity: with randomized interleaving, a meaningful fraction of races must
    // have actually hit a 409 (otherwise we proved nothing about contention).
    expect(racesWith409, "races that exercised a real 409 CAS retry").toBeGreaterThan(0);
  });
});
