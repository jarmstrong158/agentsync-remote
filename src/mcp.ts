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
import { log } from "./log.js";
import {
  type JsonRpcMessage,
  type JsonSchemaLike,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  handleJsonRpcHttp,
  isNotification,
  negotiateProtocol,
  rpcError,
  rpcResult,
  validateArguments,
} from "./shared/mcp-core.js";
import {
  RetryExhaustedError,
  checkConflicts,
  claim,
  history,
  mailbox,
  release,
  survey,
  updateStatus,
} from "./tools.js";
import type { Ctx } from "./types.js";

const SERVER_INFO = { name: "agentsync-remote", version: "0.1.0" };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchemaLike;
  handler: (ctx: Ctx, args: any) => Promise<unknown>;
}

// Cardinality and length caps. These are advertised in the schema AND enforced
// at the call boundary by the same object (see validateArguments), so what a
// client is told and what the server accepts cannot drift apart.
//
// They are not cosmetic: claims.json is a single shared file that every peer --
// including the local Python agentsync server -- fetches and parses on EVERY
// operation, so an unbounded claim is an availability problem for the whole
// mesh, not just for the caller. MAX_PATH_LENGTH additionally bounds the input
// to the glob matcher (see overlap.ts).
const MAX_TASK_LENGTH = 4000;
const MAX_NOTE_LENGTH = 4000;
const MAX_PATHS = 64;
const MAX_PATH_LENGTH = 256;
const MAX_BRANCH_LENGTH = 255;
const MAX_MESSAGE_LENGTH = 4000;

const pathArray = (desc: string): JsonSchemaLike => ({
  type: "array",
  items: { type: "string", maxLength: MAX_PATH_LENGTH },
  maxItems: MAX_PATHS,
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
        task: {
          type: "string",
          maxLength: MAX_TASK_LENGTH,
          description: "Short description of the work.",
        },
        touches: pathArray("Paths/globs this work will modify (e.g. ['src/api', 'src/**'])."),
        requires: pathArray("Paths/globs this work depends on but will not modify."),
        branch: {
          type: "string",
          maxLength: MAX_BRANCH_LENGTH,
          description: "The feature branch this work lands on.",
        },
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
          maxLength: MAX_BRANCH_LENGTH,
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
        note: {
          type: ["string", "null"],
          maxLength: MAX_NOTE_LENGTH,
          description: "Optional free-form note.",
        },
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
        note: {
          type: ["string", "null"],
          maxLength: MAX_NOTE_LENGTH,
          description: "Optional closing note.",
        },
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
          minimum: 1,
          maximum: 100,
          description: "How many commits to return (default 20, max 100).",
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
        message: {
          type: "string",
          maxLength: MAX_MESSAGE_LENGTH,
          description: "Note to post. Omit to read the mailbox.",
        },
        to: {
          type: "string",
          maxLength: 128,
          description: "Optional peer id this note is addressed to.",
        },
      },
      additionalProperties: false,
    },
    handler: (ctx, a) => mailbox(ctx, a),
  },
];

// --------------------------------------------------------------------------
// JSON-RPC plumbing
//
// The envelope (batching, notifications, parse errors, body-size and batch
// caps), protocol negotiation and argument validation all live in
// src/shared/mcp-core.ts, shared byte-identically with context-keeper-remote
// and cambium-remote. Only the MCP method semantics below are repo-specific.
// --------------------------------------------------------------------------

async function handleMessage(
  msg: JsonRpcMessage,
  ctx: Ctx,
): Promise<object | null> {
  const method = msg.method;

  switch (method) {
    case "initialize": {
      // Previously this echoed whatever the client sent, so asking for
      // "banana" got you `protocolVersion: "banana"` -- the server advertising
      // a protocol it does not implement. Now an unrecognized request
      // negotiates DOWN to our pinned revision, which is what the spec's
      // version negotiation is for.
      const { version, requested, downgraded } = negotiateProtocol(msg.params?.protocolVersion);
      log("handshake", { phase: "start", protocol_version: version, requested, downgraded });
      const res = rpcResult(msg.id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      log("handshake", { phase: "complete", protocol_version: version });
      return res;
    }

    case "ping":
      return rpcResult(msg.id, {});

    case "tools/list":
      return rpcResult(msg.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case "tools/call": {
      const name = msg.params?.name;
      const started = Date.now();
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        log("error", { message: `Unknown tool: ${name}` });
        return rpcError(msg.id, RPC_INVALID_PARAMS, `Unknown tool: ${name}`);
      }

      // ENFORCE the schema we advertise. Until this existed the handlers took
      // `msg.params?.arguments ?? {}` completely raw, so
      // `claim({task: 123, touches: "src/api"})` type-confused straight through
      // `args.touches ?? []` into computeOverlap, which iterated the STRING
      // character by character ("src/api" -> 's','r','c','/','a','p','i'),
      // produced nonsense conflicts, and then committed a schema-violating
      // ClaimEntry into the claims.json the local Python peer also consumes.
      const args = msg.params?.arguments ?? {};
      const problems = validateArguments(tool.inputSchema, args);
      if (problems.length > 0) {
        log("error", { message: `Invalid arguments for ${name}: ${problems.join("; ")}` });
        return rpcError(
          msg.id,
          RPC_INVALID_PARAMS,
          `Invalid arguments for ${name}: ${problems.join("; ")}`,
        );
      }

      try {
        const out = await tool.handler(ctx, args);
        log("tool_call", { tool: name, duration_ms: Date.now() - started, ok: true });
        return rpcResult(msg.id, {
          content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
          isError: false,
        });
      } catch (e) {
        // Tool-execution errors are reported as isError content (so the model
        // sees them), not as JSON-RPC protocol errors.
        //
        // RetryExhaustedError is deliberately in this bucket. It used to be
        // returned as an ordinary `{status: "retry_exhausted"}` payload inside
        // a result with NO isError flag, i.e. indistinguishable from success to
        // anything skimming the envelope -- an agent could read "retry" and
        // believe its claim had landed when nothing was written at all.
        const message =
          e instanceof GhPatMissingError
            ? `Configuration error: ${e.message}`
            : e instanceof RetryExhaustedError
              ? `Not applied: ${e.message}`
              : `Error: ${e instanceof Error ? e.message : String(e)}`;
        log("tool_call", { tool: name, duration_ms: Date.now() - started, ok: false });
        log("error", {
          message: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
        });
        return rpcResult(msg.id, {
          content: [{ type: "text", text: message }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification(msg)) return null;
      return rpcError(msg.id, RPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
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
    return handleJsonRpcHttp(request, (msg) => handleMessage(msg, ctx), {
      // No server-initiated SSE stream and no session to tear down.
      allow: "POST, DELETE",
      handleDelete: true,
      onError: (e) =>
        log("error", {
          message: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
        }),
    });
  };
}
