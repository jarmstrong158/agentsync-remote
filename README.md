# agentsync-remote

A Cloudflare Worker MCP server that makes **claude.ai on your phone** a peer in
the [agentsync](https://github.com/jarmstrong158/agentsync) coordination mesh —
the same `claims.json`, the same `agentsync` branch, the same overlap and
compare-and-swap rules as local agentsync, with **no git and no local clone**.

Your laptop's Claude Code (local agentsync) and your phone's claude.ai
(agentsync-remote) claim work against the **one** shared `claims.json`. Two
transports, one mesh. A local peer and this remote peer are indistinguishable in
`claims.json` except by their agent id.

> **Sibling, not a fork.** This is a second *transport* onto the same
> coordination file as local [agentsync](https://github.com/jarmstrong158/agentsync)
> — not a variant of it. See [`DESIGN.md`](./DESIGN.md) for how `git push`-as-CAS
> becomes GitHub-contents-API-as-CAS.

## What it gives you

Seven tools over Streamable HTTP MCP:

| Tool              | What it does                                                            |
| ----------------- | ---------------------------------------------------------------------- |
| `survey`          | The whole board: every peer's claim, your conflicts, the mailbox.      |
| `claim`           | Claim work; blocked if it overlaps an active peer (CAS-safe).          |
| `check_conflicts` | Re-check your claim against peers, optionally on one branch.           |
| `update_status`   | Move your claim through `planning` / `in-progress` / `done`.           |
| `release`         | Mark your claim done (done never blocks peers).                        |
| `history`         | Recent commits on the coordination branch (local + remote interleaved).|
| `mailbox`         | Human-in-the-loop notes: ask from the desktop, answer from the phone.  |

## Setup (phone-only, in order)

You need this done once. Steps 1 and 2 are the only ones that touch a secret.

### 1. Make a GitHub token (fine-grained PAT)

GitHub → **Settings → Developer settings → Fine-grained personal access
tokens → Generate new token**:

- **Repository access:** *Only select repositories* → pick **only** the repo
  that holds your coordination branch (`jarmstrong158/agentsync-remote` unless
  you changed `REPO` in `wrangler.toml`).
- **Permissions → Repository permissions → Contents:** **Read and write**.
- Nothing else. Generate it and copy the token.

### 2. First deploy, then add the two runtime secrets

The first push to `main` deploys the Worker via GitHub Actions (the repo secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are already set). After it
deploys once:

Cloudflare dashboard → **Workers & Pages → `agentsync-remote` → Settings →
Variables and Secrets** → add two **Secret** values, then **Deploy**:

| Secret       | Value                                                                 |
| ------------ | --------------------------------------------------------------------- |
| `AUTH_TOKEN` | A long random string you invent. It locks the endpoint — treat it like a password. |
| `GH_PAT`     | The fine-grained token from step 1.                                   |

Until `AUTH_TOKEN` is set the Worker answers **every** request with `404` (it
fails closed). Until `GH_PAT` is set the tools return a clear error naming the
missing secret.

### 3. Connect claude.ai to the Worker

claude.ai (web) → **Settings → Connectors → Add custom connector**. URL:

```
https://agentsync-remote.jarmstrong158.workers.dev/mcp/<AUTH_TOKEN>
```

Put the `AUTH_TOKEN` you chose in step 2 straight into the path (that *is* the
auth — there is no separate login).

### 4. Test it

Ask Claude: **"call survey"**. You should get the coordination board back (empty
`claims` on a fresh mesh — the Worker bootstraps the branch and file for you).

## Cross-transport walkthrough — two transports, one mesh

This is the whole point. The laptop and the phone coordinate through one file.

**On the PC (local agentsync, Claude Code):**

```
> agentsync claim --task "refactor auth" --touches src/auth --branch feature/auth
{"status": "claimed", ...}          # writes claims["laptop"] on the agentsync branch
```

**On the phone (claude.ai + agentsync-remote):**

```
You: call survey
Claude: laptop is active — task "refactor auth", touches src/auth, branch feature/auth.

You: claim task "tidy auth helpers", touches src/auth/helpers.ts
Claude: blocked. Overlap with an active peer claim:
        laptop — "refactor auth" — shared_files: ["src/auth/helpers.ts"]
        Narrow `touches`, wait, or re-call with force=true.

You: mailbox "Taking src/auth/helpers.ts once you land the refactor — ok?" to "laptop"
Claude: posted.
```

**Back on the PC**, the desktop agent (or you) reads the note via `survey` /
`mailbox`, answers it, and releases:

```
> agentsync mailbox "go for it, helpers are stable now"
> agentsync release --note "refactor landed"
{"status": "released"}              # laptop's claim -> status "done"
```

**On the phone again:**

```
You: claim task "tidy auth helpers", touches src/auth/helpers.ts
Claude: claimed.                    # laptop is "done" now, so it no longer blocks

You: (later) release note "helpers tidied"
Claude: released.
```

Every one of those steps was a compare-and-swap against the **same**
`claims.json` on the **same** branch. The laptop never saw a remote peer; the
phone never saw a git repo. Same mesh.

## Configuration

Non-secret config lives in [`wrangler.toml`](./wrangler.toml):

| Var          | Default                          | Meaning                               |
| ------------ | -------------------------------- | ------------------------------------- |
| `REPO`       | `jarmstrong158/agentsync-remote` | `owner/name` of the coordination repo.|
| `AGENT_ID`   | `jonny-mobile`                   | This peer's id in `claims.json`.      |
| `BRANCH`     | `agentsync`                      | The coordination branch.              |
| `CLAIMS_PATH`| `claims.json`                    | The coordination file.                |

Point local agentsync and this Worker at the **same** `REPO` + `BRANCH` +
`CLAIMS_PATH` and they share one mesh.

## Develop

```bash
npm install
npm test          # vitest, fetch-mocked — no live GitHub calls
npm run typecheck
npx wrangler deploy --dry-run --outdir dist   # bundle check, no credentials needed
```

Deploys happen automatically on push to `main` (see
[`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)): tests must
pass before Wrangler ships.

## See also

- [agentsync](https://github.com/jarmstrong158/agentsync) — the local transport
  (Claude Code on your machine). Same file, same rules; sibling transport.
- [`DESIGN.md`](./DESIGN.md) — the CAS translation, overlap semantics, and why
  the MCP handler is stateless and hand-rolled.
