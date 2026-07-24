// ===========================================================================
// XYLEM SHARED MCP CORE — CANONICAL COPY, KEPT BYTE-IDENTICAL
// ===========================================================================
//
// This file is the SINGLE definition of the pieces that three Workers were
// each maintaining their own copy of, and had already drifted on within six
// weeks of first shipping:
//
//   * context-keeper-remote
//   * agentsync-remote
//   * cambium-remote
//
// The drift that motivated extracting it:
//   - `safeEqual` existed three times with the same "kept in sync with the
//     sibling Worker" comment and three different behaviours (one decoded the
//     percent-encoded path segment before comparing, two did not; all three
//     early-returned on a length mismatch and so leaked the token length).
//   - `initialize` echoed the client's `protocolVersion` verbatim in two of
//     the three, so asking for "banana" got you `protocolVersion: "banana"`.
//   - The JSON-RPC envelope (batch handling, 202-for-notifications, parse
//     errors) was copy-pasted and diverging.
//
// RULES FOR THIS FILE
//   1. It has NO imports. That is deliberate: it must drop into any of the
//      three repos unchanged, regardless of their differing module
//      resolution (extensionless vs explicit `.js` specifiers).
//   2. It is byte-identical in all three repos. `test/shared-drift.test.ts`
//      in each repo pins the SAME sha-256 of this file's LF-normalized
//      bytes. Editing it in one repo turns that repo's suite red until the
//      constant is updated, and updating the constant in only one repo makes
//      the divergence visible in review.
//   3. Nothing repo-specific goes in here. Tool definitions, GitHub clients,
//      D1 access, and logging stay in their own repos and are injected.
//
// TODO(shared-layer): rule 2 is a drift DETECTOR, not real sharing. The
// intended end state is a published `@xylem/mcp-core` package (or a git
// subtree) that all three depend on by version, so there is exactly one
// artifact rather than three synchronized files. That was deliberately not
// attempted in the same pass as the security fixes below: it needs an npm
// scope, a release workflow, and a coordinated version bump across three
// deploy pipelines. Do it before a FOURTH Worker is created.
// ===========================================================================

// ---------------------------------------------------------------------------
// Protocol negotiation
// ---------------------------------------------------------------------------

/** The protocol revision these Workers implement. */
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** Revisions we will agree to speak if a client asks for one of them. Anything
 *  else negotiates DOWN to our pinned version — we never echo an unrecognized
 *  string back, which previously let a client dictate the advertised protocol
 *  (`protocolVersion: "banana"`). */
export const SUPPORTED_PROTOCOLS: ReadonlySet<string> = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

export interface NegotiatedProtocol {
  /** The version we will actually speak, always one of SUPPORTED_PROTOCOLS. */
  version: string;
  /** What the client asked for, for logging. null if it asked for nothing. */
  requested: string | null;
  /** True when the client asked for something we do not support. */
  downgraded: boolean;
}

export function negotiateProtocol(requested: unknown): NegotiatedProtocol {
  const asked = typeof requested === "string" ? requested : null;
  const supported = asked !== null && SUPPORTED_PROTOCOLS.has(asked);
  return {
    version: supported ? (asked as string) : DEFAULT_PROTOCOL_VERSION,
    requested: asked,
    downgraded: asked !== null && !supported,
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC envelope
// ---------------------------------------------------------------------------

export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

export interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  // Params are untrusted client input by definition; every consumer must
  // validate before use (see validateArguments below).
  params?: any;
}

export function rpcResult(id: string | number | null | undefined, res: unknown): object {
  return { jsonrpc: "2.0", id: id ?? null, result: res };
}

export function rpcError(
  id: string | number | null | undefined,
  code: number,
  message: string,
  data?: unknown,
): object {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/** A JSON-RPC message with no id (absent or null) is a notification and gets no
 *  response, as is anything in the `notifications/` namespace. */
export function isNotification(msg: JsonRpcMessage): boolean {
  if (msg.id === undefined || msg.id === null) return true;
  return typeof msg.method === "string" && msg.method.startsWith("notifications/");
}

/** Build the standard MCP tool-call result envelope. `isError` is ALWAYS set
 *  explicitly: omitting it on a failure path is how a "retry_exhausted" payload
 *  used to reach a model dressed as a successful call. */
export function toolResultEnvelope(payload: unknown, isError: boolean): object {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return { content: [{ type: "text", text }], isError };
}

// ---------------------------------------------------------------------------
// Request-size and cardinality limits
// ---------------------------------------------------------------------------
//
// Every one of these Workers writes to shared, unbounded storage (a GitHub
// file, a D1 table) on behalf of whoever holds the path token. Without a
// ceiling, one oversized call can bloat a coordination file every peer must
// then fetch and parse on every single operation.

/** Largest POST body we will parse, in bytes. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
/** Largest JSON-RPC batch we will process in one request. */
export const MAX_BATCH_MESSAGES = 64;
/** Largest path-token we will even attempt to compare. */
export const MAX_TOKEN_LENGTH = 512;

const JSON_HEADERS = { "Content-Type": "application/json" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export interface HttpEnvelopeOptions {
  /** Value for the `Allow` header on a 405. Defaults to "POST". */
  allow?: string;
  /** Answer DELETE with 204 (stateless: there is no session to tear down). */
  handleDelete?: boolean;
  /** Called for any throw escaping `dispatch`, so the repo can log it. */
  onError?: (err: unknown) => void;
}

/**
 * Turn one Streamable HTTP POST into one JSON-RPC response.
 *
 * `dispatch` handles a single message and returns its response object, or null
 * for a notification. A throw from `dispatch` degrades that ONE message to an
 * internal-error response; it never takes down the batch or bubbles a 500 that
 * a reconnecting client reads as a hard failure.
 */
export async function handleJsonRpcHttp(
  request: Request,
  dispatch: (msg: JsonRpcMessage) => Promise<object | null>,
  opts: HttpEnvelopeOptions = {},
): Promise<Response> {
  const allow = opts.allow ?? "POST";

  if (opts.handleDelete && request.method === "DELETE") {
    return new Response(null, { status: 204 });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: allow } });
  }

  // Cheap pre-check before we buffer anything.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
    return jsonResponse(
      rpcError(null, RPC_INVALID_REQUEST, `Request body too large (max ${MAX_REQUEST_BYTES} bytes)`),
    );
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return jsonResponse(rpcError(null, RPC_PARSE_ERROR, "Parse error"));
  }
  if (raw.length > MAX_REQUEST_BYTES) {
    return jsonResponse(
      rpcError(null, RPC_INVALID_REQUEST, `Request body too large (max ${MAX_REQUEST_BYTES} bytes)`),
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return jsonResponse(rpcError(null, RPC_PARSE_ERROR, "Parse error"));
  }

  const isBatch = Array.isArray(payload);
  if (isBatch && (payload as unknown[]).length > MAX_BATCH_MESSAGES) {
    return jsonResponse(
      rpcError(null, RPC_INVALID_REQUEST, `Batch too large (max ${MAX_BATCH_MESSAGES} messages)`),
    );
  }
  const messages = (isBatch ? payload : [payload]) as JsonRpcMessage[];

  const responses: object[] = [];
  for (const message of messages) {
    let res: object | null;
    try {
      res = await dispatch(message ?? {});
    } catch (err) {
      if (opts.onError) opts.onError(err);
      res = rpcError(message?.id ?? null, RPC_INTERNAL_ERROR, "Internal error");
    }
    if (res !== null) responses.push(res);
  }

  // Notification-only batch: nothing to return.
  if (responses.length === 0) return new Response(null, { status: 202 });

  return jsonResponse(isBatch ? responses : responses[0]);
}

// ---------------------------------------------------------------------------
// Constant-time credential comparison
// ---------------------------------------------------------------------------
//
// The previous implementation, copied into all three Workers, opened with
//     if (a.length !== b.length) return false;
// which returns in nanoseconds for a wrong-length guess and in microseconds for
// a right-length one — a remotely observable oracle for the secret's LENGTH,
// which is exactly the parameter an attacker needs before brute-forcing the
// content. We hash both sides to fixed-width 32-byte digests under an ephemeral
// per-isolate HMAC key and compare THOSE, which is the standard construction
// (cf. Django's constant_time_compare, Rack::Utils.secure_compare).
//
// Residual: HMAC cost still scales with input length, but the only
// attacker-varied input is the attacker's own guess, and the digest comparison
// itself is fixed at 32 iterations regardless of either input.

let hmacKeyPromise: Promise<CryptoKey> | undefined;

function ephemeralHmacKey(): Promise<CryptoKey> {
  // Generated lazily, never at module scope: Workers forbid random values in
  // the global scope, and a per-isolate key means the digests are unguessable.
  if (hmacKeyPromise === undefined) {
    const material = crypto.getRandomValues(new Uint8Array(32));
    hmacKeyPromise = crypto.subtle.importKey(
      "raw",
      material,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return hmacKeyPromise;
}

/** Compare two strings without leaking their contents OR their lengths. */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const key = await ephemeralHmacKey();
  const encoder = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.sign("HMAC", key, encoder.encode(a)),
    crypto.subtle.sign("HMAC", key, encoder.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  // Both digests are always exactly 32 bytes, so this loop is fixed-length.
  for (let i = 0; i < 32; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Check a `/mcp/:token` path segment against the configured AUTH_TOKEN.
 *
 * Fails CLOSED: an unset/empty secret can never match anything, so an
 * unconfigured Worker authenticates nobody rather than everybody.
 *
 * The segment is percent-decoded first, so a token containing URL-reserved
 * characters works. `decodeURIComponent` throws a URIError on a malformed
 * escape (`/mcp/%zz`) — previously that throw happened OUTSIDE the request
 * try/catch and became an uncaught 500, so it is contained here.
 */
export async function pathTokenMatches(
  segment: string,
  expected: string | undefined | null,
): Promise<boolean> {
  if (!expected) return false;
  if (segment.length > MAX_TOKEN_LENGTH) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    decoded = segment;
  }
  return timingSafeEqual(decoded, expected);
}

// ---------------------------------------------------------------------------
// Runtime argument validation
// ---------------------------------------------------------------------------
//
// A tool that ADVERTISES an inputSchema and does not ENFORCE it is worse than
// one with no schema at all: every caller, human or model, reasonably assumes
// the declared types hold. They did not. `claim({task: 123, touches: "src/api"})`
// used to sail through `args.touches ?? []` into the overlap engine, which
// iterated the STRING character by character (so "src/api" became the tokens
// 's','r','c','/','a','p','i'), produced nonsense conflicts, and then wrote a
// schema-violating entry into a coordination file that a separate local Python
// server also reads.
//
// This validator deliberately checks against the VERY SAME JSON Schema object
// that tools/list advertises, so the contract shown to the client and the
// contract enforced by the server cannot drift apart. It implements the subset
// of JSON Schema these Workers actually use — and no `pattern` keyword, so no
// schema can ever introduce a regex.

export interface JsonSchemaLike {
  type?: string | string[];
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaLike;
  enum?: unknown[];
  maxLength?: number;
  minLength?: number;
  maxItems?: number;
  minItems?: number;
  maximum?: number;
  minimum?: number;
  description?: string;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  const t = typeof value;
  if (t === "number") return Number.isInteger(value as number) ? "integer" : "number";
  return t;
}

function typeMatches(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  // JSON Schema: an integer is also a number.
  if (expected === "number" && actual === "integer") return true;
  return false;
}

function validateNode(
  schema: JsonSchemaLike,
  value: unknown,
  path: string,
  errors: string[],
): void {
  // Stop piling on once a call is clearly bad; the first few reasons are the
  // useful ones and an unbounded list is itself a response-size problem.
  if (errors.length >= 12) return;

  const actual = jsonTypeOf(value);

  if (schema.type !== undefined) {
    const allowed = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!allowed.some((t) => typeMatches(t, actual))) {
      errors.push(`${path}: expected ${allowed.join(" or ")}, got ${actual}`);
      return;
    }
  }

  if (actual === "number" || actual === "integer") {
    if (!Number.isFinite(value as number)) {
      errors.push(`${path}: must be a finite number`);
      return;
    }
    if (schema.minimum !== undefined && (value as number) < schema.minimum) {
      errors.push(`${path}: must be >= ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && (value as number) > schema.maximum) {
      errors.push(`${path}: must be <= ${schema.maximum}`);
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    return;
  }

  if (actual === "string") {
    const s = value as string;
    if (schema.maxLength !== undefined && s.length > schema.maxLength) {
      errors.push(`${path}: must be at most ${schema.maxLength} characters (got ${s.length})`);
    }
    if (schema.minLength !== undefined && s.length < schema.minLength) {
      errors.push(`${path}: must be at least ${schema.minLength} characters`);
    }
  }

  if (actual === "array") {
    const arr = value as unknown[];
    if (schema.maxItems !== undefined && arr.length > schema.maxItems) {
      errors.push(`${path}: must have at most ${schema.maxItems} items (got ${arr.length})`);
      return;
    }
    if (schema.minItems !== undefined && arr.length < schema.minItems) {
      errors.push(`${path}: must have at least ${schema.minItems} items`);
    }
    if (schema.items) {
      for (let i = 0; i < arr.length; i++) {
        validateNode(schema.items, arr[i], `${path}[${i}]`, errors);
        if (errors.length >= 12) return;
      }
    }
  }

  if (actual === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) {
        errors.push(`${path === "(root)" ? "" : path + "."}${key}: required`);
      }
    }
    const props = schema.properties ?? {};
    for (const [key, child] of Object.entries(obj)) {
      const childSchema = props[key];
      if (childSchema === undefined) {
        if (schema.additionalProperties === false) {
          errors.push(`${path === "(root)" ? "" : path + "."}${key}: unexpected property`);
        }
        continue;
      }
      // An explicitly-undefined property is treated as absent, not as null.
      if (child === undefined) continue;
      validateNode(childSchema, child, `${path === "(root)" ? "" : path + "."}${key}`, errors);
      if (errors.length >= 12) return;
    }
  }
}

/** Validate a tools/call `arguments` object against its advertised schema.
 *  Returns [] when valid, else a list of human-readable problems. */
export function validateArguments(schema: JsonSchemaLike, value: unknown): string[] {
  const errors: string[] = [];
  // A missing `arguments` is an empty object, matching MCP client behaviour.
  validateNode(schema, value === undefined || value === null ? {} : value, "(root)", errors);
  return errors;
}
