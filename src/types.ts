// Shared types for agentsync-remote.
//
// The wire shapes here are the compatibility contract with local agentsync
// (github.com/jarmstrong158/agentsync). A ClaimEntry written by this remote
// peer must be byte-shape-identical to one written by a local peer, so that a
// local and a remote agent are indistinguishable in claims.json except by id.

export type ClaimStatus = "planning" | "in-progress" | "done";

export interface ClaimEntry {
  task: string;
  touches: string[];
  requires: string[];
  branch: string;
  status: ClaimStatus;
  updated_at: string; // ISO 8601 UTC
  instance: string; // random token per server instance
  note: string | null;
}

// mailbox() note. A remote-native extension carried in the same file under a
// top-level `notes` array. The key is only written when at least one note
// exists, so files with no notes stay identical to pure-local agentsync output.
export interface MailboxNote {
  from: string;
  to: string | null;
  message: string;
  at: string; // ISO 8601 UTC
}

// Top-level document shape. `claims` is the compatibility surface; `notes` is
// the optional mailbox extension.
export interface ClaimsDoc {
  claims: Record<string, ClaimEntry>;
  notes?: MailboxNote[];
}

// Worker configuration + secrets binding.
export interface Env {
  // Secrets (set in the Cloudflare dashboard, never in code/repo).
  AUTH_TOKEN?: string;
  GH_PAT?: string;
  // Vars (wrangler.toml).
  REPO: string;
  AGENT_ID?: string;
  BRANCH?: string;
  CLAIMS_PATH?: string;
}

// Per-request execution context: resolved config plus injectable clock, sleep,
// and instance token so the core logic is deterministic under test.
export interface Ctx {
  env: Env;
  repo: string;
  agentId: string;
  branch: string;
  claimsPath: string;
  instance: string;
  now: () => string;
  sleep: (ms: number) => Promise<void>;
}

// A single reported overlap reason within a conflict.
export interface ConflictReason {
  type: "shared_files" | "depends_on_their_wip";
  files: string[];
}

// Per-peer conflict detail in a blocked/check_conflicts response.
export interface PeerConflict {
  their_task: string;
  their_branch: string;
  reasons: ConflictReason[];
}

export type Conflicts = Record<string, PeerConflict>;
