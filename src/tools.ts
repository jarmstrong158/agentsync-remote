// Core coordination logic and the MCP tool implementations.
//
// Every write goes through casLoop(): read fresh state (bootstrapping the branch
// and file if missing), let a pure decision function mutate the doc, then PUT
// with the blob sha. A 409 (another peer committed first) re-reads and re-runs
// the decision against the *fresh* state -- so claim() re-checks overlap on
// every retry and never blocks or writes against stale data. Because each agent
// edits only its own key in `claims`, a retry never clobbers a peer's entry.

import {
  createBranch,
  getBranchSha,
  getContent,
  getDefaultBranch,
  listCommits,
  putContent,
} from "./github.js";
import { computeOverlap } from "./overlap.js";
import type {
  ClaimEntry,
  ClaimStatus,
  ClaimsDoc,
  Conflicts,
  Ctx,
  Env,
  MailboxNote,
} from "./types.js";

export const PUSH_RETRIES = 5;
export const BACKOFF_BASE_MS = 400;

const BLOCKED_MESSAGE =
  "Overlap with an active peer claim. Narrow `touches`, wait, or re-call with force=True.";
const EXHAUSTED_MESSAGE =
  "Push kept losing the race; call survey() and try again.";
const VALID_STATUSES: ClaimStatus[] = ["planning", "in-progress", "done"];

// --------------------------------------------------------------------------
// Context construction
// --------------------------------------------------------------------------

export function buildCtx(
  env: Env,
  overrides: Partial<Pick<Ctx, "now" | "sleep" | "instance">> = {},
): Ctx {
  return {
    env,
    repo: env.REPO,
    agentId: env.AGENT_ID || "jonny-mobile",
    branch: env.BRANCH || "agentsync",
    claimsPath: env.CLAIMS_PATH || "claims.json",
    instance: overrides.instance ?? crypto.randomUUID(),
    now: overrides.now ?? (() => new Date().toISOString()),
    sleep:
      overrides.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
  };
}

// --------------------------------------------------------------------------
// State load (with branch/file bootstrap) and CAS commit
// --------------------------------------------------------------------------

function serialize(doc: ClaimsDoc): string {
  // Only emit `notes` when non-empty, so a claims.json with no mailbox activity
  // stays shape-identical to pure-local agentsync output. `claims` is always
  // first.
  const out: ClaimsDoc = { claims: doc.claims };
  if (doc.notes && doc.notes.length > 0) out.notes = doc.notes;
  return JSON.stringify(out, null, 2) + "\n";
}

function parse(raw: string): ClaimsDoc {
  const obj = JSON.parse(raw) as Partial<ClaimsDoc>;
  return { claims: obj.claims ?? {}, notes: obj.notes };
}

interface LoadedState {
  doc: ClaimsDoc;
  sha?: string; // undefined only for a freshly created empty doc
}

/** Read claims.json on the coordination branch, bootstrapping the branch and/or
 *  file if either is missing. */
async function loadState(ctx: Ctx): Promise<LoadedState> {
  const existing = await getContent(ctx, ctx.claimsPath, ctx.branch);
  if (existing) return { doc: parse(existing.content), sha: existing.sha };

  // File (or branch) missing. Ensure the branch exists.
  const branchSha = await getBranchSha(ctx, ctx.branch);
  if (!branchSha) {
    const def = await getDefaultBranch(ctx);
    const defSha = await getBranchSha(ctx, def);
    if (!defSha) {
      throw new Error(`Cannot bootstrap: default branch '${def}' has no ref.`);
    }
    await createBranch(ctx, ctx.branch, defSha);
    // The file may have been carried over from the default branch.
    const carried = await getContent(ctx, ctx.claimsPath, ctx.branch);
    if (carried) return { doc: parse(carried.content), sha: carried.sha };
  }

  // Initialize an empty coordination file.
  const empty: ClaimsDoc = { claims: {} };
  const put = await putContent(ctx, ctx.claimsPath, {
    message: `agentsync: initialize ${ctx.claimsPath}`,
    content: serialize(empty),
    branch: ctx.branch,
  });
  return { doc: empty, sha: put.sha };
}

interface Decision<T> {
  // Early return without writing (e.g. blocked / read-only / no_claim).
  return?: T;
  // Otherwise commit `message` and return `result`.
  message?: string;
  result?: T;
}

/** Read-mutate-commit with compare-and-swap retries. The decision function runs
 *  against *fresh* state on every attempt. */
async function casLoop<T>(
  ctx: Ctx,
  decide: (doc: ClaimsDoc) => Decision<T>,
): Promise<T> {
  for (let attempt = 0; attempt < PUSH_RETRIES; attempt++) {
    const { doc, sha } = await loadState(ctx);
    const decision = decide(doc);

    if ("return" in decision && decision.return !== undefined) {
      return decision.return;
    }

    const put = await putContent(ctx, ctx.claimsPath, {
      message: decision.message!,
      content: serialize(doc),
      branch: ctx.branch,
      sha,
    });

    if (put.ok) return decision.result as T;

    // 409: another peer committed first. Back off and retry against fresh state.
    if (attempt < PUSH_RETRIES - 1) {
      await ctx.sleep(BACKOFF_BASE_MS * (attempt + 1));
    }
  }
  return {
    status: "retry_exhausted",
    message: EXHAUSTED_MESSAGE,
  } as unknown as T;
}

// --------------------------------------------------------------------------
// Overlap / conflict detection
// --------------------------------------------------------------------------

/** Detect conflicts between my (touches, requires) and every active peer.
 *  Peers with status "done" never block. */
export function detectConflicts(
  myId: string,
  mine: { touches: string[]; requires: string[] },
  claims: Record<string, ClaimEntry>,
): Conflicts {
  const conflicts: Conflicts = {};
  for (const [peerId, peer] of Object.entries(claims)) {
    if (peerId === myId) continue;
    if (peer.status === "done") continue;

    const reasons = [];
    const shared = computeOverlap(mine.touches, peer.touches);
    if (shared.length > 0) reasons.push({ type: "shared_files" as const, files: shared });

    const dep = computeOverlap(mine.requires, peer.touches);
    if (dep.length > 0) reasons.push({ type: "depends_on_their_wip" as const, files: dep });

    if (reasons.length > 0) {
      conflicts[peerId] = {
        their_task: peer.task,
        their_branch: peer.branch,
        reasons,
      };
    }
  }
  return conflicts;
}

// --------------------------------------------------------------------------
// Tools
// --------------------------------------------------------------------------

/** survey(): the whole coordination board plus my conflicts and the mailbox. */
export async function survey(ctx: Ctx): Promise<unknown> {
  const { doc } = await loadState(ctx);
  const claims = doc.claims;

  let activeCount = 0;
  for (const c of Object.values(claims)) if (c.status !== "done") activeCount++;

  const mine = claims[ctx.agentId];
  let myConflicts: Conflicts | null = null;
  if (mine) {
    const cf = detectConflicts(
      ctx.agentId,
      { touches: mine.touches, requires: mine.requires },
      claims,
    );
    myConflicts = Object.keys(cf).length ? cf : null;
  }

  return {
    repo: ctx.repo,
    branch: ctx.branch,
    agent_id: ctx.agentId,
    claims,
    active_count: activeCount,
    my_claim: mine ?? null,
    my_conflicts: myConflicts,
    notes: doc.notes ?? [],
  };
}

export interface ClaimArgs {
  task: string;
  touches: string[];
  requires?: string[];
  branch?: string;
  force?: boolean;
}

/** claim(): the full CAS loop. Overlap is re-checked against fresh peer state on
 *  every retry. */
export async function claim(ctx: Ctx, args: ClaimArgs): Promise<unknown> {
  const touches = args.touches ?? [];
  const requires = args.requires ?? [];
  const workBranch = args.branch ?? "(unspecified)";
  const force = args.force ?? false;

  return casLoop(ctx, (doc) => {
    if (!force) {
      const conflicts = detectConflicts(
        ctx.agentId,
        { touches, requires },
        doc.claims,
      );
      if (Object.keys(conflicts).length > 0) {
        return { return: { status: "blocked", message: BLOCKED_MESSAGE, conflicts } };
      }
    }

    const existing = doc.claims[ctx.agentId];
    const entry: ClaimEntry = {
      task: args.task,
      touches,
      requires,
      branch: workBranch,
      status: "in-progress",
      updated_at: ctx.now(),
      instance: ctx.instance,
      note: null,
    };
    doc.claims[ctx.agentId] = entry;

    const result: Record<string, unknown> = { status: "claimed", claim: entry };
    if (existing && existing.instance && existing.instance !== ctx.instance) {
      result.warning =
        `Another server instance (${existing.instance}) already holds agent_id ` +
        `'${ctx.agentId}'. If this is unexpected, you may be running duplicate ` +
        `servers configured with the same AGENT_ID.`;
    }

    return {
      message: `agentsync: ${ctx.agentId} claims '${args.task}'`,
      result,
    };
  });
}

export interface CheckConflictsArgs {
  against_branch?: string;
}

/** check_conflicts(): re-evaluate my current claim against active peers,
 *  optionally narrowed to peers working on a specific branch. */
export async function checkConflicts(
  ctx: Ctx,
  args: CheckConflictsArgs = {},
): Promise<unknown> {
  const { doc } = await loadState(ctx);
  const mine = doc.claims[ctx.agentId];
  if (!mine) {
    return {
      status: "no_claim",
      message: "You have no active claim. Call claim() first.",
      agent_id: ctx.agentId,
    };
  }

  let conflicts = detectConflicts(
    ctx.agentId,
    { touches: mine.touches, requires: mine.requires },
    doc.claims,
  );

  if (args.against_branch) {
    const filtered: Conflicts = {};
    for (const [peerId, detail] of Object.entries(conflicts)) {
      if (doc.claims[peerId]?.branch === args.against_branch) {
        filtered[peerId] = detail;
      }
    }
    conflicts = filtered;
  }

  return {
    status: Object.keys(conflicts).length ? "conflicts" : "clear",
    against_branch: args.against_branch ?? null,
    conflicts,
  };
}

export interface UpdateStatusArgs {
  status: ClaimStatus;
  note?: string | null;
}

/** update_status(): change my claim's status (and optionally its note). */
export async function updateStatus(
  ctx: Ctx,
  args: UpdateStatusArgs,
): Promise<unknown> {
  if (!VALID_STATUSES.includes(args.status)) {
    return {
      status: "error",
      message: `Invalid status '${args.status}'. Must be one of: ${VALID_STATUSES.join(", ")}.`,
    };
  }
  return casLoop<unknown>(ctx, (doc) => {
    const mine = doc.claims[ctx.agentId];
    if (!mine) {
      return {
        return: {
          status: "no_claim",
          message: "You have no active claim. Call claim() first.",
        },
      };
    }
    mine.status = args.status;
    if (args.note !== undefined) mine.note = args.note;
    mine.updated_at = ctx.now();
    return {
      message: `agentsync: ${ctx.agentId} updates status to '${args.status}'`,
      result: { status: "updated", claim: mine },
    };
  });
}

export interface ReleaseArgs {
  note?: string | null;
}

/** release(): mark my claim done (done peers never block) and optionally leave a
 *  closing note. */
export async function release(ctx: Ctx, args: ReleaseArgs = {}): Promise<unknown> {
  return casLoop<unknown>(ctx, (doc) => {
    const mine = doc.claims[ctx.agentId];
    if (!mine) {
      return {
        return: {
          status: "no_claim",
          message: "You have no active claim to release.",
        },
      };
    }
    mine.status = "done";
    if (args.note !== undefined) mine.note = args.note;
    mine.updated_at = ctx.now();
    return {
      message: `agentsync: ${ctx.agentId} releases '${mine.task}'`,
      result: { status: "released", claim: mine },
    };
  });
}

export interface HistoryArgs {
  limit?: number;
}

/** history(): recent commits on the coordination branch, so a phone can watch
 *  the interleaved local+remote coordination history. */
export async function history(ctx: Ctx, args: HistoryArgs = {}): Promise<unknown> {
  const limit = args.limit ?? 20;
  const commits = await listCommits(ctx, ctx.branch, limit);
  return {
    repo: ctx.repo,
    branch: ctx.branch,
    commits: commits.map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.message,
      author: c.author,
      date: c.date,
    })),
  };
}

export interface MailboxArgs {
  message?: string;
  to?: string;
}

/** mailbox(): the human-in-the-loop channel. With a message, append a note under
 *  the same CAS; without one, read the mailbox. A desktop agent posts a
 *  question, the human answers from the phone, the desktop agent proceeds. */
export async function mailbox(ctx: Ctx, args: MailboxArgs = {}): Promise<unknown> {
  const message = args.message;

  if (message === undefined || message === null || message === "") {
    // Read-only: no write, no CAS commit.
    const { doc } = await loadState(ctx);
    return { status: "read", notes: doc.notes ?? [] };
  }

  return casLoop(ctx, (doc) => {
    if (!doc.notes) doc.notes = [];
    const note: MailboxNote = {
      from: ctx.agentId,
      to: args.to ?? null,
      message,
      at: ctx.now(),
    };
    doc.notes.push(note);
    return {
      message: `agentsync: ${ctx.agentId} posts a note`,
      result: { status: "posted", note, notes: doc.notes },
    };
  });
}
