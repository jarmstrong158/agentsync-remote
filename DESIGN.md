# DESIGN — agentsync-remote

`agentsync-remote` is a Cloudflare Worker that makes **claude.ai on a phone** a
first-class peer in the [agentsync](https://github.com/jarmstrong158/agentsync)
coordination mesh. It speaks the same `claims.json`, on the same branch, with
the same overlap and compare-and-swap semantics as local agentsync — but with
**no git binary and no local clone**. Its only state lives in GitHub, reached
over the REST API.

A local agentsync peer and this remote peer are indistinguishable in
`claims.json` except by their agent id.

## Founding design decision: CAS via the GitHub contents API

Local agentsync's **Decision 3** is *`git push` as compare-and-swap*: fetch,
hard-reset the worktree to the remote, re-read claims, re-check overlap, commit,
and push; a rejected push means someone else pushed first, so resync and retry.

The GitHub contents API gives us compare-and-swap natively. `PUT
/repos/{owner}/{repo}/contents/{path}` requires the **current blob `sha`**; a
stale sha returns **HTTP 409**. That maps the git-push loop onto plain HTTP:

| local agentsync                | agentsync-remote                          |
| ------------------------------ | ----------------------------------------- |
| fetch + hard-reset worktree    | `GET contents?ref=BRANCH` → content + sha |
| read claims, re-check overlap  | same, in the Worker                       |
| commit + push                  | `PUT contents` with sha                   |
| push rejected → resync, retry  | 409 → re-`GET`, re-evaluate, retry        |

Each agent edits **only its own key** in `claims`, so a retry re-applies our
entry on top of the fresh document and **never loses a peer's entry**. Overlap
is re-checked against fresh state on **every** attempt, so a claim can never be
granted against a peer that appeared mid-race.

`PUSH_RETRIES = 5`, backoff `0.4s * (attempt + 1)` between attempts. On
exhaustion we return `{"status": "retry_exhausted", ...}`.

The single generic driver for this is `casLoop()` in `src/tools.ts`: it loads
fresh state (bootstrapping the branch/file if missing), runs a pure decision
function that may either early-return (blocked / read-only / no-claim) or mutate
the doc and supply a commit message, then PUTs with the sha and retries on 409.
`claim`, `update_status`, `release`, and `mailbox` (write path) all share it.

## Why a hand-rolled, stateless MCP handler

The brief names *Cloudflare Agents SDK, `createMcpHandler`, Streamable HTTP*. In
practice the two obvious library routes each carry state machinery this Worker
does not want:

- The Cloudflare Agents SDK's `McpAgent` requires a **Durable Object** binding
  for per-session continuity.
- `mcp-handler`'s `createMcpHandler` pulls in **`redis`** (for SSE
  resumability) and a Next.js peer dependency.

This Worker holds **no state** — its only state is in GitHub — so it needs
neither. `src/mcp.ts` therefore exports a small `createMcpHandler()` that
implements **stateless Streamable HTTP** directly:

- `POST /mcp/:token` carries one JSON-RPC request (or a batch). We answer with a
  single `application/json` JSON-RPC response, which the Streamable HTTP spec
  explicitly permits for a POST that carries requests. Notifications get `202`.
- `GET` returns `405` (no server-initiated SSE stream in stateless mode);
  `DELETE` returns `204` (no session to tear down).
- Supported methods: `initialize`, `ping`, `tools/list`, `tools/call`, and the
  `notifications/*` namespace.

The upside: it bundles to ~6 KiB gzipped with zero runtime dependencies, has no
Durable Object / Redis / D1 bindings, and the entire protocol surface plus every
tool is unit-testable with nothing but `fetch` mocks.

## Auth: fail closed

`POST /mcp/:token`. The path token is compared to the `AUTH_TOKEN` secret. If
`AUTH_TOKEN` is unset, **or** the token mismatches, the Worker returns a bare
`404` with no detail — an unconfigured or wrongly-addressed endpoint is
indistinguishable from one that does not exist. The `GH_PAT` secret is *not*
checked at the edge; a missing `GH_PAT` surfaces as a clear, named tool-level
error only once an authenticated caller invokes a tool that needs GitHub.

## Overlap semantics (ported verbatim)

Path tokens are normalized (trim, drop leading `./` or `/`, drop trailing `/`,
collapse `//`). Two tokens overlap if:

1. **exact** match, or
2. **directory containment** either direction (`src/api` vs `src/api/routes.py`
   — prefix + `"/"`), or
3. **glob** match either direction (`src/**`, `*.py` — fnmatch-style, where `*`
   is *not* special about `/`, matching Python's `fnmatch`).

Conflicts are reported per peer with reasons:

- `{"type": "shared_files", "files": [...]}` — my `touches` ∩ peer `touches`.
- `{"type": "depends_on_their_wip", "files": [...]}` — my `requires` ∩ peer
  `touches`.

Peers with `status: "done"` never block. `files` lists the **peer's** contended,
normalized, de-duplicated, sorted tokens — it reads naturally per peer ("these
files of theirs collide with your work") and is deterministic for tests.

## Compatibility surface

- File `claims.json` on branch `agentsync` (both configurable via
  `wrangler.toml` vars). Top-level shape `{"claims": {"<agent_id>": {...}}}`.
- Claim entry fields, exactly: `task`, `touches`, `requires`, `branch`,
  `status` (`planning` | `in-progress` | `done`), `updated_at` (ISO 8601 UTC),
  `instance` (random token per server instance), `note`.
- `instance` is a random UUID minted per isolate/deployment. If a claim already
  exists under our `AGENT_ID` but carries a *different* instance, `claim()`
  attaches a `warning` — the duplicate-agent-id signal.
- Commit messages interleave cleanly with local peers' history:
  - `agentsync: <id> claims '<task>'`
  - `agentsync: <id> updates status to '<status>'`
  - `agentsync: <id> releases '<task>'`
  - `agentsync: <id> posts a note`
  - `agentsync: initialize claims.json`

### `branch` default

`claim(branch?)` is optional. A local peer supplies its checked-out branch; a
remote peer has no working copy, so when `branch` is omitted we write the honest
placeholder `"(unspecified)"` rather than guess. Operators should pass an
explicit feature branch when they have one. This only ever affects a *value*,
never the entry *shape* — the compatibility contract is preserved.

## `mailbox` — the remote-native tool (rationale)

`mailbox(message?, to?)` is the one tool with no local analogue. It appends
free-form notes to a top-level **`notes` array in the same file**, under the same
CAS. It is the **human-in-the-loop channel**: a desktop agent posts a question
(`mailbox("Ship v2 endpoint or hold?", to: "jonny-mobile")`), the human reads and
answers it from their phone (`mailbox("hold — API not frozen")`), and the desktop
agent proceeds. Coordination and the human conversation about it live in one
compare-and-swap'd file, so they can never disagree.

**Compatibility care:** the `notes` key is written **only when at least one note
exists**. A `claims.json` with no mailbox activity is byte-shape-identical to
pure-local agentsync output, and any existing `notes` array is always preserved
across every CAS write (we re-serialize the whole document, mutating only our own
data).

## Bootstrap

If the coordination branch is missing, we create it from the repo's default
branch via the git refs API. If `claims.json` is missing, we initialize it to
`{"claims": {}}` via the contents API. Any tool call triggers bootstrap through
`loadState()`, so a fresh repo becomes a working mesh on first use.

## Tool inventory

`survey`, `claim`, `check_conflicts`, `update_status`, `release`, `history`, and
the remote-native `mailbox`. The local-only / gh-CLI / PR-workflow tools
(`provision`, `add_collaborator`, `finish`) are intentionally omitted — a phone
peer coordinates; it does not provision infrastructure.

## Deployment

GitHub Actions → Wrangler (see `.github/workflows/deploy.yml`), **not** the
Cloudflare GitHub App and **not** `wrangler` from a dev container. Push to `main`
→ checkout → Node 22 → `npm ci` → `npx vitest run` → `npx wrangler deploy`.
Tests gate the deploy. Cloudflare credentials come from the repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; the two **runtime** secrets
(`AUTH_TOKEN`, `GH_PAT`) are set by the operator in the Cloudflare dashboard and
never live in the repo.
