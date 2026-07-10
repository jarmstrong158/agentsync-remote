// Structured, single-line request/protocol logging.
//
// One JSON object per line so Cloudflare Workers Logs (dashboard: Workers &
// Pages -> agentsync-remote -> Logs) can filter on the `event` field. The goal
// is to diagnose the next dropped handshake in one look: a `request` with no
// matching `handshake` complete, or a slow `tool_call`, tells the whole story.
//
// SECURITY: the path token is the credential. It is NEVER logged -- callers log
// the route with the token redacted.

export type LogEvent = "request" | "auth" | "handshake" | "tool_call" | "error";

export function log(event: LogEvent, fields: Record<string, unknown> = {}): void {
  try {
    // Drop undefined fields so lines stay compact.
    const clean: Record<string, unknown> = { event };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) clean[k] = v;
    }
    clean.timestamp = Date.now();
    console.log(JSON.stringify(clean));
  } catch {
    console.log(JSON.stringify({ event: "error", message: "log serialization failed" }));
  }
}
