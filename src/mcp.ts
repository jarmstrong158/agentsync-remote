// A small, self-contained stateless Streamable HTTP MCP handler.
//
// Why hand-rolled rather than a library: this Worker keeps NO state (its only
// state lives in GitHub), so it needs neither Durable Objects (as the Cloudflare
// Agents SDK's McpAgent requires) nor Redis-backed SSE resumability (as
// mcp-handler pulls in). A stateless request/response JSON-RPC handler is the
// exact fit, is trivial to bundle on Workers, and is fully unit-testable. The
// Streamable HTTP spec permits an `application/json` response to a POST that
// carries JSON-RPC requests, which is what we return. See DESIGN.md.

import { GhPatMissingError } from "./github.js";
import {
  checkConflicts,
  claim,
  history,
  mailbox,
  release,
  survey,
  updateStatus,
} from "./tools.js";
import type { Ctx } from "./types.js";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "agentsync-remote", version: "0.1.0" };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (ctx: Ctx, args: any) => Promise<unknown>;
}

const pathArray = (desc: string) => ({
  type: "array",
  items: { type: "string" },
  description: desc,
});

export const TOOLS: ToolDef[] = [
  {
    name: "survey",
    description:
      "Show the whole agentsync coordination board: every peer's active claim, " +
      "your own claim and any conflicts it has, and the shared mailbox. Call " +
      "this first to see what local and remote peers are working on.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: (ctx) => survey(ctx),
  },
  {
    name: "claim",
    description:
      "Claim a unit of work so peers don't collide. Runs a compare-and-swap " +
      "against the shared claims.json: if your `touches` overlap an active " +
      "peer's claim (or your `requires` depend on their work-in-progress) the " +
      "call is blocked with the conflicting peers. Narrow `touches`, wait, or " +
      "re-call with force=true.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "Short description of the work." },
        touches: pathArray("Paths/globs this work will modify (e.g. ['src/api', 'src/**'])."),
        requires: pathArray("Paths/globs this work depends on but will not modify."),
        branch: { type: "string", description: "The feature branch this work lands on." },
        force: {
          type: "boolean",
          description: "Claim even if it overlaps an active peer.",
        },
      },
      required: ["task", "touches"],
      additionalProperties: false,
    },
    handler: (ctx, a) => claim(ctx, a),
  },
  {
    name: "check_conflicts",
    description:
      "Re-check your current claim against active peers without modifying " +
      "anything. Optionally narrow to peers working on a specific branch.",
    inputSchema: {
      type: "object",
      properties: {
        against_branch: {
          type: "string",
          description: "Only report conflicts with peers on this branch.",
        },
      },
      additionalProperties: false,
    },
    handler: (ctx, a) => checkConflicts(ctx, a),
  },
  {
    name: "update_status",
    description:
      "Update your claim's status (planning | in-progress | done) and " +
      "optionally its note.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["planning", "in-progress", "done"],
          description: "New status for your claim.",
        },
        note: { type: ["string", "null"], description: "Optional free-form note." },
      },
      required: ["status"],
      additionalProperties: false,
    },
    handler: (ctx, a) => updateStatus(ctx, a),
  },
  {
    name: "release",
    description:
      "Release your claim by marking it done (done claims never block peers), " +
      "optionally with a closing note.",
    inputSchema: {
      type: "object",
      properties: {
        note: { type: ["string", "null"], description: "Optional closing note." },
      },
      additionalProperties: false,
    },
    handler: (ctx, a) => release(ctx, a),
  },
  {
    name: "history",
    description:
      "Recent commits on the coordination branch, so you can see the " +
      "interleaved history of local and remote peers' claims and releases.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "How many commits to return (default 20).",
        },
      },
      additionalProperties: false,
    },
    handler: (ctx, a) => history(ctx, a),
  },
  {
    name: "mailbox",
    description:
      "The human-in-the-loop channel. With a `message`, post a free-form note " +
      "into the shared file (optionally addressed `to` a peer). With no " +
      "message, read the current mailbox. Use it to ask a question a human can " +
      "answer from their phone, or to answer one.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Note to post. Omit to read the mailbox." },
        to: { type: "string", description: "Optional peer id this note is addressed to." },
      },
      additionalProperties: false,
    },
    handler: (ctx, a) => mailbox(ctx, a),
  },
];

// --------------------------------------------------------------------------
// JSON-RPC plumbing
// --------------------------------------------------------------------------

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: any;
}

function result(id: string | number | null | undefined, res: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result: res };
}

function error(
  id: string | number | null | undefined,
  code: number,
  message: string,
) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleMessage(
  msg: JsonRpcMessage,
  ctx: Ctx,
): Promise<object | null> {
  const method = msg.method;

  // Notifications (no id, or the notifications/* namespace) get no response.
  const isNotification = msg.id === undefined || method?.startsWith("notifications/");

  switch (method) {
    case "initialize":
      return result(msg.id, {
        protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "ping":
      return result(msg.id, {});

    case "tools/list":
      return result(msg.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const name = msg.params?.name;
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return error(msg.id, -32602, `Unknown tool: ${name}`);
      }
      try {
        const out = await tool.handler(ctx, msg.params?.arguments ?? {});
        return result(msg.id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        });
      } catch (e) {
        // Tool-execution errors are reported as isError content (so the model
        // sees them), not as JSON-RPC protocol errors.
        const message =
          e instanceof GhPatMissingError
            ? `Configuration error: ${e.message}`
            : `Error: ${e instanceof Error ? e.message : String(e)}`;
        return result(msg.id, {
          content: [{ type: "text", text: message }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return null;
      return error(msg.id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Build a stateless Streamable HTTP MCP request handler. POST carries JSON-RPC
 * request(s); we answer with a single `application/json` JSON-RPC response (or
 * 202 for a notification-only batch). GET/DELETE are handled minimally since
 * this server offers no server-initiated stream and holds no session.
 */
export function createMcpHandler(): (request: Request, ctx: Ctx) => Promise<Response> {
  return async (request: Request, ctx: Ctx): Promise<Response> => {
    if (request.method === "GET") {
      // No server-initiated SSE stream in stateless mode.
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST, DELETE" },
      });
    }
    if (request.method === "DELETE") {
      // No session to tear down.
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST, DELETE" },
      });
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json(error(null, -32700, "Parse error"), 200);
    }

    const isBatch = Array.isArray(payload);
    const messages = (isBatch ? payload : [payload]) as JsonRpcMessage[];

    const responses: object[] = [];
    for (const message of messages) {
      const res = await handleMessage(message, ctx);
      if (res !== null) responses.push(res);
    }

    if (responses.length === 0) {
      // Notification-only: nothing to return.
      return new Response(null, { status: 202 });
    }

    return json(isBatch ? responses : responses[0], 200);
  };
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
