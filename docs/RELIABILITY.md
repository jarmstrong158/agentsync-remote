# agentsync-remote — Reliability Report

**Generated:** 2026-07-08 · **Base commit:** `fbd6ecb` (this report and the
simulated-contention test are added in the same change) ·
**Suite:** `vitest run`, fetch-mocked (no live GitHub calls).

This report is measurement and documentation only — no application code
(`src/`) was changed to produce it. Every number below is reproducible with the
commands in [Reproduce](#reproduce); the randomized stress test is seeded, so it
reproduces byte-for-byte.

## What this measures (and what it doesn't)

agentsync-remote coordinates peers by compare-and-swap (CAS) on a single
`claims.json` file: read the file + its blob `sha`, re-check overlap, `PUT` with
that `sha`; a stale `sha` returns HTTP 409, which drives a re-read + retry. (See
[`DESIGN.md`](../DESIGN.md).)

The tests exercise **the Worker's own CAS loop and overlap logic**. GitHub is
replaced by an in-process fake ([`test/helpers.ts`](../test/helpers.ts)) that
reproduces the one property coordination depends on: a `PUT` with a stale `sha`
returns 409. So these results validate the coordination *logic* — not GitHub's
live API, not network behavior, not real-world latency. Where a result comes
from simulated contention, it is labelled as such.

## Summary

| Metric | Value | Plain-English meaning | How measured |
| --- | --- | --- | --- |
| Automated tests passing | **47 / 47** | The entire suite is green. | `npx vitest run` |
| Distinct CAS race scenarios | **5** | Five different ways two writers can collide are covered (3 deterministic unit cases + 2 simulated-contention modes). | see [Race scenarios](#cas-race-scenarios) |
| Simulated concurrent races | **1000** | Two peers raced for work one thousand times under randomized interleaving. | `test/stress-cas.test.ts` (seeded) |
| Lost claims across races | **0 / 1000** | No granted claim was ever dropped or overwritten by a peer. | stress test invariant |
| Double-granted claims across races | **0 / 1000** | Two peers never both won overlapping work. | stress test invariant |
| Races that hit a real 409 retry | **1000 / 1000** | Every race was genuinely contended, not accidentally serialized. | stress test counter |
| Races with a winner (liveness) | **1000 / 1000** | Every race granted at least one claim; no mutual starvation. | stress test invariant |
| Overlap-detection coverage | exact · directory-containment · glob | All three matching modes are tested, each in both directions, plus no-false-positives and "done peers never block". | `test/overlap.test.ts` |
| Auth rejection paths | **3 + fail-closed** | Wrong token, unset token, and non-`/mcp` path all 404; unset `AUTH_TOKEN` denies everything. | `test/mcp.test.ts` |

Stress-run detail (seed `0x5eed`, N=1000):
`overlap=497 disjoint=503 lostClaims=0 doubleGrants=0 racesWith409=1000 total409=1000`.

## CAS race scenarios

The five distinct ways two writers can collide, and where each is proven:

| # | Scenario | Invariant proven | Test |
| --- | --- | --- | --- |
| 1 | A peer commits an **overlapping** claim between my read and my write | The 409 forces a re-read; I see the new peer and **block** instead of overwriting them. | `cas.test.ts › 409 CAS -> blocked (forced rejection analogue) › first PUT 409s, re-GET shows a peer's new overlapping claim -> blocked` |
| 2 | A peer commits a **non-overlapping** claim mid-write | The 409 is retried; my claim lands and **both peers' entries survive** (no lost update). | `cas.test.ts › 409 CAS -> retry succeeds, peer entry survives › non-overlapping peer race: retry lands, both entries present` |
| 3 | **Unbounded** contention — every write loses the race | After `PUSH_RETRIES` the loop gives up cleanly with `retry_exhausted`, never hanging or corrupting the file. | `cas.test.ts › PUSH_RETRIES exhaustion › every PUT 409s -> retry_exhausted shape` |
| 4 | Two peers race concurrently for **overlapping** work (simulated) | Exactly one wins; the other is cleanly **blocked** — never a double-grant. | `stress-cas.test.ts` (497 of 1000 races) |
| 5 | Two peers race concurrently for **disjoint** work (simulated) | Both win and **both entries coexist** — never a lost claim. | `stress-cas.test.ts` (503 of 1000 races) |

## Per-invariant detail

Each invariant, in one sentence, with the exact test that proves it.

### Compare-and-swap coordination

- **A stale write never overwrites a peer.** When a 409 reveals a newly-arrived
  overlapping peer, the claim re-reads and blocks rather than clobbering.
  — `cas.test.ts › 409 CAS -> blocked (forced rejection analogue) › first PUT 409s, re-GET shows a peer's new overlapping claim -> blocked`
- **A losing race preserves everyone's entries.** A 409 from a non-overlapping
  peer is retried and the final file contains both peers, because each agent
  only edits its own key.
  — `cas.test.ts › 409 CAS -> retry succeeds, peer entry survives › non-overlapping peer race: retry lands, both entries present`
- **Contention terminates, it doesn't corrupt.** If every attempt loses, the
  loop returns `retry_exhausted` after a bounded number of retries.
  — `cas.test.ts › PUSH_RETRIES exhaustion › every PUT 409s -> retry_exhausted shape`
- **A granted claim matches the exact wire contract.** A successful claim writes
  the precise `claims.json` entry shape and an interleaving commit message.
  — `cas.test.ts › claim() happy path › writes an entry with the exact contract shape and commit message`
- **`force` is an explicit, tested escape hatch.** With `force=true` a claim
  intentionally overrides an overlapping active peer.
  — `cas.test.ts › force bypasses overlap › claims over an overlapping active peer when force=true`
- **1000 randomized concurrent races: 0 lost claims, 0 double-grants** (simulated
  contention). — `stress-cas.test.ts › simulated contention: claim() CAS under randomized races`

### Overlap / conflict detection

- **Exact-path collisions are detected.** — `overlap.test.ts › pathsOverlap › (a) exact match`
- **Directory containment is detected both directions** (`src/api` vs
  `src/api/routes.py`). — `overlap.test.ts › pathsOverlap › (b) directory containment, both directions`
- **Globs are detected both directions** (`src/**`, `*.py`). —
  `overlap.test.ts › pathsOverlap › (c) glob match, both directions`
- **Unrelated paths do not falsely collide.** —
  `overlap.test.ts › pathsOverlap › does not over-match unrelated paths`
- **Shared-file conflicts are reported** (`touches` ∩ peer `touches`). —
  `overlap.test.ts › detectConflicts › shared_files for touches vs peer.touches`
- **Dependency conflicts are reported** (`requires` ∩ peer `touches`). —
  `overlap.test.ts › detectConflicts › depends_on_their_wip for requires vs peer.touches`
- **Completed peers never block new work.** —
  `overlap.test.ts › detectConflicts › done-status peers never block`

### Bootstrap (cold start)

- **A missing branch + file is auto-provisioned before the first claim.** —
  `cas.test.ts › branch/file bootstrap when missing › creates the branch and initializes {claims:{}} then claims`
- **Reads bootstrap too.** A survey on an empty repo initializes and returns an
  empty board. — `cas.test.ts › branch/file bootstrap when missing › survey on an empty repo initializes and returns empty claims`
- **End-to-end from cold:** against an empty repo (no branch, no file),
  `survey → claim → survey` works with zero manual setup. —
  `cold-start.test.ts › cold start: fresh deploy against an empty repo`

### Auth (fail closed)

- **A wrong path token is rejected with a bare 404.** —
  `mcp.test.ts › auth (fail closed) › wrong token -> 404 with no detail`
- **An unset `AUTH_TOKEN` denies every request.** —
  `mcp.test.ts › auth (fail closed) › unset AUTH_TOKEN -> 404 even with a token in the path`
- **Non-`/mcp` paths are 404.** —
  `mcp.test.ts › auth (fail closed) › non-/mcp path -> 404`
- **A correct token is accepted.** —
  `mcp.test.ts › auth (fail closed) › correct token -> ping succeeds`
- **A missing `GH_PAT` fails with a clear, named error** (not a silent
  failure). — `mcp.test.ts › protocol › tools/call surfaces missing GH_PAT as a named isError message`

## Reproduce

Deterministic; the stress test is seeded (`0x5eed`).

```bash
npm ci

# Full suite (47 tests):
npx vitest run

# Just the simulated-contention stress test, with its summary line:
npx vitest run test/stress-cas.test.ts --reporter=verbose
# -> [stress-cas] races=1000 overlap=497 disjoint=503 lostClaims=0 doubleGrants=0 racesWith409=1000 total409=1000
```

## Suggested phrasings

Ranked by punch for a general audience. Each carries the caveat that keeps it
honest — **use the caveat, or use a lower-punch line.**

1. **"Two agents raced for the same work a thousand times — zero collisions,
   zero lost work."**
   *Caveat:* the thousand races are *simulated in-process* — GitHub's 409
   compare-and-swap is reproduced by a fake, not exercised over the live API.
   The claim it backs is about the coordination logic, which is what runs in
   production.

2. **"Across 1,000 simulated concurrent races, the compare-and-swap
   coordination never double-granted overlapping work and never dropped a claim
   (0 / 1000 on both)."**
   *Caveat:* say "simulated" — same as above. Note that all 1,000 races were
   genuinely contended (each hit a real 409 retry), so the number isn't inflated
   by trivially-serialized runs.

3. **"Every automated test passes (47 / 47), covering five distinct
   compare-and-swap race scenarios and all three overlap-detection modes —
   exact, directory, and glob."**
   *Caveat:* these are unit/integration tests with a mocked GitHub; they prove
   the Worker's logic, not GitHub's API or network reliability. This is the most
   conservative phrasing and needs the least qualification.
