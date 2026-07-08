import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { createMcpHandler } from "../src/mcp.js";
import type { Env } from "../src/types.js";
import { fakeGitHub, testCtx } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

const ENV: Env = {
  AUTH_TOKEN: "secret",
  GH_PAT: "ghp_test",
  REPO: "owner/repo",
  AGENT_ID: "jonny-mobile",
  BRANCH: "agentsync",
  CLAIMS_PATH: "claims.json",
};

function post(token: string, body: unknown): Request {
  return new Request(`https://w.example/mcp/${token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("auth (fail closed)", () => {
  it("wrong token -> 404 with no detail", async () => {
    const res = await worker.fetch(post("wrong", { jsonrpc: "2.0", id: 1, method: "ping" }), ENV);
    expect(res.status).toBe(404);
  });

  it("unset AUTH_TOKEN -> 404 even with a token in the path", async () => {
    const res = await worker.fetch(post("anything", { jsonrpc: "2.0", id: 1, method: "ping" }), {
      ...ENV,
      AUTH_TOKEN: undefined,
    });
    expect(res.status).toBe(404);
  });

  it("non-/mcp path -> 404", async () => {
    const res = await worker.fetch(
      new Request("https://w.example/", { method: "POST", body: "{}" }),
      ENV,
    );
    expect(res.status).toBe(404);
  });

  it("correct token -> ping succeeds", async () => {
    const res = await worker.fetch(post("secret", { jsonrpc: "2.0", id: 1, method: "ping" }), ENV);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.result).toEqual({});
  });
});

describe("protocol", () => {
  const handler = createMcpHandler();
  const req = (body: unknown) =>
    new Request("https://w.example/mcp/secret", {
      method: "POST",
      body: JSON.stringify(body),
    });

  it("initialize returns capabilities and serverInfo", async () => {
    const res = await handler(req({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), testCtx());
    const json = (await res.json()) as any;
    expect(json.result.serverInfo.name).toBe("agentsync-remote");
    expect(json.result.capabilities.tools).toBeDefined();
  });

  it("tools/list exposes the seven mesh tools", async () => {
    const res = await handler(req({ jsonrpc: "2.0", id: 2, method: "tools/list" }), testCtx());
    const json = (await res.json()) as any;
    const names = json.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(
      ["check_conflicts", "claim", "history", "mailbox", "release", "survey", "update_status"].sort(),
    );
  });

  it("notifications/initialized yields 202 with no body", async () => {
    const res = await handler(req({ jsonrpc: "2.0", method: "notifications/initialized" }), testCtx());
    expect(res.status).toBe(202);
  });

  it("GET is 405 (no server-initiated stream)", async () => {
    const res = await handler(
      new Request("https://w.example/mcp/secret", { method: "GET" }),
      testCtx(),
    );
    expect(res.status).toBe(405);
  });

  it("tools/call survey returns text content", async () => {
    const fake = fakeGitHub({ claims: {} });
    vi.stubGlobal("fetch", fake.fetch);
    const res = await handler(
      req({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "survey", arguments: {} } }),
      testCtx(),
    );
    const json = (await res.json()) as any;
    expect(json.result.content[0].type).toBe("text");
    const payload = JSON.parse(json.result.content[0].text);
    expect(payload.agent_id).toBe("jonny-mobile");
  });

  it("tools/call surfaces missing GH_PAT as a named isError message", async () => {
    const res = await handler(
      req({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "survey", arguments: {} } }),
      testCtx({ GH_PAT: undefined }),
    );
    const json = (await res.json()) as any;
    expect(json.result.isError).toBe(true);
    expect(json.result.content[0].text).toMatch(/GH_PAT/);
  });

  it("unknown tool -> JSON-RPC error", async () => {
    const res = await handler(
      req({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope" } }),
      testCtx(),
    );
    const json = (await res.json()) as any;
    expect(json.error.code).toBe(-32602);
  });
});
