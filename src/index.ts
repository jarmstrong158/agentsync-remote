// Worker entry point.
//
// Routing: POST /mcp/:token. The path token is checked against the AUTH_TOKEN
// secret. The server fails CLOSED: if AUTH_TOKEN is unset, or the token does not
// match, we return a bare 404 with no detail -- an unconfigured or wrongly
// addressed endpoint is indistinguishable from a nonexistent one.
//
// The GH_PAT secret is NOT checked here; a missing GH_PAT surfaces as a clear,
// named tool-level error only once an authenticated caller actually invokes a
// tool that needs GitHub.

import { createMcpHandler } from "./mcp.js";
import { buildCtx } from "./tools.js";
import type { Env } from "./types.js";

// One random instance token per isolate/deployment. This powers the
// duplicate-agent-id warning: if a claim already exists under this AGENT_ID but
// carries a different instance, another server is using the same id.
const INSTANCE = crypto.randomUUID();

const handleMcp = createMcpHandler();

const NOT_FOUND = () => new Response("Not Found", { status: 404 });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const match = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);
    if (!match) return NOT_FOUND();

    const token = match[1];
    // Fail closed: unset AUTH_TOKEN or a mismatched token -> 404, no detail.
    if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) return NOT_FOUND();

    const ctx = buildCtx(env, { instance: INSTANCE });
    return handleMcp(request, ctx);
  },
} satisfies ExportedHandler<Env>;
