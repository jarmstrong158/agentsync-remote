// Conformance tests for MCP protocol revision 2026-07-28.
//
// This Worker hand-rolls its MCP layer, so these tests are load-bearing:
// nothing else checks the wire shape.
//
// It is deliberately DUAL-ERA. The legacy assertions matter as much as the
// modern ones -- an already-configured client speaks the handshake era until
// it is upgraded, and legacy clients have no fall-forward mechanism.

import { describe, expect, it } from "vitest";

import worker from "../src/index.js";
import type { Env } from "../src/types.js";

const MODERN = "2026-07-28";

const ENV: Env = {
  AUTH_TOKEN: "secret",
  GH_PAT: "ghp_test",
  REPO: "owner/repo",
  AGENT_ID: "jonny-mobile",
  BRANCH: "agentsync",
  CLAIMS_PATH: "claims.json",
};

let id = 500;

/** POST as a MODERN client: per-request `_meta` plus the standard headers. */
function modernPost(
  method: string,
  params: Record<string, unknown> = {},
  opts: {
    version?: string;
    headerVersion?: string;
    mcpMethod?: string;
    mcpName?: string;
    omit?: ("version" | "method" | "name")[];
  } = {},
): Request {
  const version = opts.version ?? MODERN;
  const omit = opts.omit ?? [];
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!omit.includes("version")) headers["MCP-Protocol-Version"] = opts.headerVersion ?? version;
  if (!omit.includes("method")) headers["Mcp-Method"] = opts.mcpMethod ?? method;
  const name = typeof params.name === "string" ? params.name : null;
  if (name && !omit.includes("name")) headers["Mcp-Name"] = opts.mcpName ?? name;

  return new Request("https://w.example/mcp/secret", {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++id,
      method,
      params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": version } },
    }),
  });
}

/** POST as a LEGACY client: no `_meta`, no 2026-07-28 headers. */
function legacyPost(method: string, params?: unknown): Request {
  return new Request("https://w.example/mcp/secret", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
  });
}

async function body(req: Request): Promise<any> {
  const res = await worker.fetch(req, ENV);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

describe("2026-07-28 modern era", () => {
  it("implements server/discover", async () => {
    const b = await body(modernPost("server/discover"));
    expect(b.result.supportedVersions).toContain(MODERN);
    expect(b.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("agentsync-remote");
  });

  it("answers server/discover to a legacy probe", async () => {
    const b = await body(legacyPost("server/discover"));
    expect(b.result.supportedVersions).toContain(MODERN);
  });

  it.each(["tools/list", "server/discover"])("returns cache hints on %s", async (method) => {
    // SEP-2549. The catalogue is static code identical for every caller.
    const b = await body(modernPost(method));
    expect(b.result.ttlMs).toBe(300_000);
    expect(b.result.cacheScope).toBe("public");
  });

  it("stamps resultType and serverInfo on results", async () => {
    const b = await body(modernPost("tools/list"));
    expect(b.result.resultType).toBe("complete");
    expect(b.result._meta["io.modelcontextprotocol/serverInfo"]).toBeDefined();
  });

  it("returns tools in a deterministic order", async () => {
    const a = await body(modernPost("tools/list"));
    const c = await body(modernPost("tools/list"));
    expect(a.result.tools.map((t: any) => t.name)).toEqual(c.result.tools.map((t: any) => t.name));
  });

  it("rejects an unsupported version instead of negotiating it down", async () => {
    // This REPLACES the previous negotiate-down hardening for modern clients:
    // 2026-07-28 requires rejecting with the supported list so the client can
    // retry. The anti-"banana" guard still governs the legacy path below.
    const b = await body(modernPost("tools/list", {}, { version: "1999-01-01" }));
    expect(b.error.code).toBe(-32022);
    expect(b.error.data.supported).toContain(MODERN);
  });
});

describe("2026-07-28 request headers", () => {
  it("rejects a missing MCP-Protocol-Version header", async () => {
    const b = await body(modernPost("tools/list", {}, { omit: ["version"] }));
    expect(b.error.code).toBe(-32020);
  });

  it("rejects a missing Mcp-Method header", async () => {
    const b = await body(modernPost("tools/list", {}, { omit: ["method"] }));
    expect(b.error.code).toBe(-32020);
  });

  it("rejects a header/body version mismatch", async () => {
    const b = await body(modernPost("tools/list", {}, { headerVersion: "2025-06-18" }));
    expect(b.error.code).toBe(-32020);
  });

  it("rejects an Mcp-Name that disagrees with the body", async () => {
    const b = await body(
      modernPost("tools/call", { name: "survey", arguments: {} }, { mcpName: "claim" }),
    );
    expect(b.error.code).toBe(-32020);
  });

  it("accepts a Base64-encoded Mcp-Name", async () => {
    const encoded = `=?base64?${btoa("survey")}?=`;
    const b = await body(
      modernPost("tools/call", { name: "survey", arguments: {} }, { mcpName: encoded }),
    );
    expect(b.error?.code).not.toBe(-32020);
  });
});

describe("legacy era is untouched", () => {
  it("still answers the initialize handshake", async () => {
    const b = await body(legacyPost("initialize", { protocolVersion: "2025-06-18" }));
    expect(b.result.protocolVersion).toBe("2025-06-18");
    expect(b.result.serverInfo.name).toBe("agentsync-remote");
  });

  it("still refuses to echo an unrecognized version back", async () => {
    // The original hardening: asking for "banana" must not make the server
    // advertise a protocol it does not implement. Retained for legacy clients.
    const b = await body(legacyPost("initialize", { protocolVersion: "banana" }));
    expect(b.result.protocolVersion).not.toBe("banana");
  });

  it("does not leak modern fields into legacy responses", async () => {
    const b = await body(legacyPost("tools/list"));
    expect(b.result.resultType).toBeUndefined();
    expect(b.result.ttlMs).toBeUndefined();
    expect(b.result._meta).toBeUndefined();
  });

  it("does not require the new headers from a legacy client", async () => {
    // Those headers did not exist in the handshake era; demanding them would
    // break every already-configured client at once.
    const b = await body(legacyPost("tools/list"));
    expect(b.error).toBeUndefined();
  });
});

describe("handshake hardening that survives the migration", () => {
  it("still answers without touching the network on a cold isolate", async () => {
    // The original property was "initialize makes no network call". The
    // handshake is gone, but the property generalizes and matters MORE now:
    // with no handshake, every request is a cold entry point. No fetch is
    // stubbed here, so any network call would throw.
    const b = await body(modernPost("server/discover"));
    expect(b.result.supportedVersions).toBeDefined();
  });

  it("still turns an unexpected throw into a JSON-RPC error, not a bare 500", async () => {
    // Independent of the handshake; lives in the index.ts catch. A reconnecting
    // client must never see a bare 500 it would read as a hard failure.
    const res = await worker.fetch(
      new Request("https://w.example/mcp/secret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not json",
      }),
      ENV,
    );
    expect(res.status).toBeLessThan(500);
    const b = JSON.parse(await res.text());
    expect(b.error).toBeDefined();
  });
});
