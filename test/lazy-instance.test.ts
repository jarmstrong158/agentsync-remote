import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/types.js";

// Regression guard for the deploy-time failure: Cloudflare Workers forbid
// generating random values (and other I/O) in the global scope. The instance
// token must therefore be minted lazily inside the request handler, not at
// module load. If someone reintroduces a module-scope crypto.randomUUID(),
// this test fails the suite before it can reach a real deploy.

describe("instance token is minted lazily, not in global scope", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("no crypto.randomUUID at import; generated once per isolate on first request", async () => {
    const spy = vi.spyOn(crypto, "randomUUID");
    vi.resetModules();

    const mod = await import("../src/index.js");
    // Nothing random may run at module-evaluation time.
    expect(spy).not.toHaveBeenCalled();

    const worker = mod.default as { fetch: (r: Request, e: Env) => Promise<Response> };
    const env = { AUTH_TOKEN: "secret", REPO: "owner/repo" } as Env;
    const ping = () =>
      new Request("https://w.example/mcp/secret", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });

    await worker.fetch(ping(), env);
    const afterFirst = spy.mock.calls.length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // Second request reuses the memoized token; no new random value.
    await worker.fetch(ping(), env);
    expect(spy.mock.calls.length).toBe(afterFirst);
  });
});
