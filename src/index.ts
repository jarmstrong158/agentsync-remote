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
import { log } from "./log.js";
import { buildCtx } from "./tools.js";
import type { Env } from "./types.js";

// One random instance token per isolate. This powers the duplicate-agent-id
// warning: if a claim already exists under this AGENT_ID but carries a different
// instance, another server is using the same id. Generated lazily on first
// request -- Workers forbid generating random values in the global scope.
let instanceToken: string | undefined;
function instanceId(): string {
  if (instanceToken === undefined) instanceToken = crypto.randomUUID();
  return instanceToken;
}

const handleMcp = createMcpHandler();

const NOT_FOUND = () => new Response("Not Found", { status: 404 });

// Length-invariant string comparison to avoid timing side channels on the token.
// Kept in sync with the sibling context-keeper-remote Worker.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    const match = url.pathname.match(/^\/mcp\/([^/]+)\/?$/);

    // The path token is the credential -> log the route with it redacted.
    log("request", {
      route: match ? "/mcp/***" : url.pathname,
      method: request.method,
    });

    if (!match) return NOT_FOUND();

    const token = match[1];
    // Fail closed: unset AUTH_TOKEN or a mismatched token -> 404, no detail.
    const ok = !!env.AUTH_TOKEN && safeEqual(token, env.AUTH_TOKEN);
    log("auth", { ok });
    if (!ok) return NOT_FOUND();

    // Handshake is pure protocol: buildCtx only assembles config, and every
    // GitHub call is deferred into the tool handlers. Nothing here touches the
    // network, so `initialize` answers instantly even on a cold isolate.
    try {
      const ctx = buildCtx(env, { instance: instanceId() });
      return await handleMcp(request, ctx);
    } catch (e) {
      // Defence in depth: an unexpected throw must not become a bare 500 that a
      // reconnecting client reads as a hard failure. Log it and answer with a
      // well-formed JSON-RPC error so the transport stays alive.
      log("error", {
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal error" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
  },
} satisfies ExportedHandler<Env>;
