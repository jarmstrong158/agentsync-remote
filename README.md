# agentsync-remote

_Part of the [xylem](https://github.com/jarmstrong158/xylem) stack._

A Cloudflare Worker MCP server that makes **claude.ai on your phone** a peer in
the [agentsync](https://github.com/jarmstrong158/agentsync) coordination mesh —
the same `claims.json`, the same `agentsync` branch, the same overlap and
compare-and-swap rules as local agentsync, with **no git and no local clone**.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/jarmstrong158/agentsync-remote)

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

## Deploy your own (one click, no command line)

Self-host this Worker in **your own** Cloudflare account. Every step is a click
path — you never touch a terminal.

### 1. Click **Deploy to Cloudflare**

Click the button above. Cloudflare will:

- fork `agentsync-remote` into **your** GitHub account,
- create the Worker in **your** Cloudflare account, and
- connect **Workers Builds** so future pushes to your fork redeploy automatically.

There are no databases or other resources to provision — this Worker keeps no
state of its own (everything lives in your GitHub repo), so the deploy is just
the Worker itself.

During the deploy dialog Cloudflare shows the Worker's **variables**. Set:

| Variable      | Set it to                                                              |
| ------------- | --------------------------------------------------------------------- |
| `REPO`        | **Your** coordination repo, as `owner/name` (the repo whose `agentsync` branch will hold `claims.json`). This is the one you must change. |
| `AGENT_ID`    | Leave as `jonny-mobile`, or pick an id for this peer.                  |
| `BRANCH`      | Leave as `agentsync` unless you want a different coordination branch.  |
| `CLAIMS_PATH` | Leave as `claims.json`.                                                |

Finish the deploy. (If you skipped setting `REPO` here, you can set it later in
the dashboard — see below.)

### 2. Make a GitHub token, then add the two Worker secrets

The Worker reads two **secrets**. These are not part of the deploy dialog — you
add them once in the dashboard after the first deploy.

**First, make the GitHub token** (this is the `GH_PAT` value):

GitHub → **Settings → Developer settings → Fine-grained personal access
tokens → Generate new token**:

- **Repository access:** *Only select repositories* → pick **only** your
  coordination repo (the one you put in `REPO`).
- **Permissions → Repository permissions → Contents:** **Read and write**.
- Nothing else. Generate it and copy the token.

**Then add both secrets to the Worker:**

Cloudflare dashboard → **Workers & Pages → your Worker → Settings → Variables
and Secrets** → **Add** → type **Secret** → add each, then **Deploy**:

| Secret       | Value                                                                              |
| ------------ | ---------------------------------------------------------------------------------- |
| `AUTH_TOKEN` | A long random string you invent. It locks the endpoint — treat it like a password. |
| `GH_PAT`     | The fine-grained GitHub token you just made.                                       |

While you're on this screen, confirm the **`REPO`** variable points at your
coordination repo (set it here if you skipped it in the deploy dialog).

> Until `AUTH_TOKEN` is set the Worker answers **every** request with `404` (it
> fails closed). Until `GH_PAT` is set the tools return a clear error naming the
> missing secret. This is by design — an unconfigured endpoint looks like it
> doesn't exist.

### 3. Add the connector in claude.ai

Find your Worker's URL: **Workers & Pages → your Worker** shows it, in the form
`https://<your-worker-name>.<your-subdomain>.workers.dev`.

claude.ai (web) → **Settings → Connectors → Add custom connector**. Paste your
Worker URL with `/mcp/` and your `AUTH_TOKEN` appended:

```
https://<your-worker-name>.<your-subdomain>.workers.dev/mcp/<AUTH_TOKEN>
```

The token in the path *is* the auth — there is no separate login.

### 4. Test it

Ask Claude: **"call survey"**. You should get the coordination board back (empty
`claims` on a fresh mesh — the Worker bootstraps the branch and file for you, so
a brand-new empty repo needs no manual setup).

## 🔒 Security — the connector URL is a credential

The connector URL embeds your `AUTH_TOKEN` in the path
(`…/mcp/<AUTH_TOKEN>`). **Anyone who has that URL can call your Worker and
read/write your coordination file.** Treat the whole URL like a password:

- Don't paste it into screenshots, issues, chats, or commits.
- Anyone with the URL is a peer in your mesh — share it only with agents/people
  you trust.
- **Rotating the token invalidates old URLs.** To revoke access, change
  `AUTH_TOKEN` in **Settings → Variables and Secrets** and redeploy; every old
  `…/mcp/<old-token>` URL immediately returns `404`. Update the connector in
  claude.ai with the new URL.

`GH_PAT` is likewise a credential — scope it to *only* your coordination repo
with *only* Contents: Read and write, so a leak can't reach anything else.

### Why the token is in the URL path, and what that costs you

This is a **deliberate design choice, not an oversight**. claude.ai custom
connectors do not reliably send custom headers, so an `Authorization:` header —
the obvious alternative — cannot be depended on. Putting the credential in the
path is what makes the connector work at all.

Be clear about the price, because it is not the same as a header:

- **URLs get recorded in places request bodies never do.** Browser history,
  shell history, proxy and CDN access logs, crash reports, bug reports,
  screenshots, "copy link" buttons, and **agent session transcripts**. During
  the audit that produced this section, the connector URLs for these Workers
  were found in **~54 occurrences across 13 local session transcripts** on a
  single machine — none pasted deliberately; they were simply part of the tool
  configuration an agent echoed back.
- **The Worker itself does not log it.** Every log line records the route as
  `/mcp/***`. The leak surface is everything *around* the Worker, which is
  exactly what you cannot audit.
- **A leaked token makes the holder a full peer in your mesh** — able to claim,
  force-claim over you, release your claims, and post to the mailbox — with no
  second factor and no per-caller identity. There is nothing to revoke except
  the token, and no log that will tell you who used it.

**Practical guidance:**

1. **Rotate on a schedule**, not just on suspicion — assume the URL has been
   recorded somewhere you don't control. Rotation is cheap: change `AUTH_TOKEN`,
   update the connector.
2. **Rotate immediately** if you've shared a terminal recording, a transcript,
   a screen capture, or a bug report from a machine where the connector is
   configured.
3. Use a **long random token** (32+ bytes, e.g. `openssl rand -hex 32`). The
   comparison is constant-time in both content *and* length, so length is not
   observable — but entropy is still your only defence against guessing.
4. If you ever get the chance to use a header or OAuth instead, **take it**.
   This tradeoff is forced by the client, not preferred.

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

> ### ⚠️ Known gap: the mailbox is currently WRITE-ONLY across tiers
>
> **The "Back on the PC" step above does not work yet.** This Worker's
> `mailbox()` writes a top-level `notes[]` array into `claims.json`, and the
> **local Python agentsync server has no concept of `notes`** — it exposes no
> `mailbox` tool, and its `survey()` returns only `me`, `branch`, `partners`
> and `stale_claims`. A note posted from the phone lands in the file correctly
> and is simply never surfaced to a desktop peer.
>
> That matters more than a missing feature normally would, because the
> repository-level agent instructions tell agents to raise judgment calls
> *through this mailbox*. An escape hatch that silently swallows the question
> is worse than no escape hatch: the agent believes it has asked and waits, or
> proceeds, on a question nobody will ever see.
>
> **Until the local side lands, read the mailbox from the remote peer**
> (`mailbox` with no `message`, or `survey`), or read `claims.json` on the
> coordination branch directly.
>
> **The local-side change required** (in the Python `agentsync` package — a
> separate repo, deliberately not modified here):
>
> 1. **Parse and preserve `notes`.** The claims-file reader must round-trip the
>    top-level `notes` key. Today an unrecognised key risks being dropped on
>    the next local write, which would *delete* remote peers' notes. Preserving
>    unknown top-level keys is the minimum safe change and should land first,
>    independently.
> 2. **Surface notes in `survey()`** — add a `notes` field alongside
>    `partners`/`stale_claims`, defaulting to `[]`.
> 3. **Add a local `mailbox(message=None, to=None)` tool** mirroring this one:
>    append `{from, to, message, at}` under the same compare-and-swap the local
>    claim writes already use, and cap retention at the 200 most recent notes
>    (this Worker evicts oldest-first at that bound — the two sides must agree,
>    or they will fight over the file).
>
> The on-disk shape is already compatible in both directions: this Worker only
> emits `notes` when non-empty, so a `claims.json` with no mailbox activity
> stays byte-shape-identical to pure-local output.

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

Non-secret config lives in [`wrangler.toml`](./wrangler.toml). Every var ships a
default so the Deploy button works with no edits; change `REPO` to your own repo.

| Var          | Default                          | Meaning                               |
| ------------ | -------------------------------- | ------------------------------------- |
| `REPO`       | `jarmstrong158/agentsync-remote` | `owner/name` of the coordination repo.|
| `AGENT_ID`   | `jonny-mobile`                   | This peer's id in `claims.json`.      |
| `BRANCH`     | `agentsync`                      | The coordination branch.              |
| `CLAIMS_PATH`| `claims.json`                    | The coordination file.                |

Two **secrets** are set in the dashboard, never in the repo: `AUTH_TOKEN` (locks
the endpoint) and `GH_PAT` (GitHub Contents read/write on the coordination repo).

Point local agentsync and this Worker at the **same** `REPO` + `BRANCH` +
`CLAIMS_PATH` and they share one mesh.

## Reliability

Coordination correctness under contention is measured, not asserted — the full
write-up is [`docs/RELIABILITY.md`](./docs/RELIABILITY.md), reproducible with the
commands below.

- **49 / 49 automated tests green**, covering five distinct CAS race scenarios
  and all three overlap-detection modes (exact · directory-containment · glob,
  each in both directions).
- **1000 simulated concurrent races** (`test/stress-cas.test.ts`, seeded
  `0x5eed`): **0 lost claims, 0 double-grants**, and every race hit a real 409
  retry — so the number isn't inflated by trivially-serialized runs.
- **Fail-closed auth is tested** — wrong token, unset `AUTH_TOKEN`, and non-`/mcp`
  paths all 404; a missing `GH_PAT` surfaces a named error, not a silent failure.
- **The MCP handshake is hardened** — `initialize` makes no network call, so it
  answers instantly even on a cold isolate; it negotiates the client's requested
  protocol version rather than rejecting a slightly-ahead client; and an
  unexpected throw anywhere becomes a well-formed JSON-RPC error, never a bare
  `500` a reconnecting client would read as a hard failure.
- **Structured logs make failures visible** — every request emits one line of
  JSON (`request` / `auth` / `handshake` / `tool_call` / `error`, with the path
  token always redacted), so a dropped handshake or a slow tool call is one
  filter away in Cloudflare Workers Logs (`[observability]` is on in
  `wrangler.toml`).

**Honest caveat:** the thousand races are simulated *in-process* — GitHub's 409
compare-and-swap is reproduced by a fetch-mocked fake ([`test/helpers.ts`](./test/helpers.ts)),
not exercised over the live API. The results validate the Worker's coordination
*logic* — which is what runs in production — not GitHub's API, the network, or
real-world latency.

## Maintainer / local development

The canonical repo (`jarmstrong158/agentsync-remote`) deploys via GitHub Actions
→ Wrangler ([`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)):
every push to `main` runs the suite and only deploys if it's green. That workflow
is guarded to the canonical repo, so a fork you created with the Deploy button
never tries to run it — your fork redeploys through Workers Builds instead.

Local checks (no Cloudflare credentials needed):

```bash
npm install
npm test          # vitest, fetch-mocked — no live GitHub calls
npm run typecheck
npx wrangler deploy --dry-run --outdir dist   # bundle check
```

## See also

- [agentsync](https://github.com/jarmstrong158/agentsync) — the local transport
  (Claude Code on your machine). Same file, same rules; sibling transport.
- [`DESIGN.md`](./DESIGN.md) — the CAS translation, overlap semantics, and why
  the MCP handler is stateless and hand-rolled.
- [`docs/RELIABILITY.md`](./docs/RELIABILITY.md) — the measured reliability
  report: 49/49 tests, five CAS race scenarios, and 1000 seeded contention races.
- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
  — Cloudflare's docs for the one-click deploy flow used above.

## Related

- [agentsync](https://github.com/jarmstrong158/agentsync) — the local git-native original this transport mirrors — and the [xylem](https://github.com/jarmstrong158/xylem) stack hub.
