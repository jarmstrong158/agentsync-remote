// Drift guard for src/shared/mcp-core.ts.
//
// That file is maintained byte-identically in context-keeper-remote,
// agentsync-remote and cambium-remote. The three Workers had already grown
// three different `safeEqual` implementations, all carrying the same "kept in
// sync with the sibling Worker" comment, so "kept in sync" by convention is
// demonstrably not a control.
//
// All three repos pin the SAME constant below. Editing the shared file in one
// repo turns that repo's suite red until the hash is updated, and a hash that
// differs between repos is a visible, reviewable divergence rather than a
// silent one. See the TODO at the top of mcp-core.ts for the real fix (one
// published artifact instead of three synchronized files).

import { describe, expect, it } from "vitest";
import source from "../src/shared/mcp-core.ts?raw";

// sha-256 of the LF-normalized bytes of src/shared/mcp-core.ts.
// To change the shared core: edit it, run this test, copy the reported actual
// hash here AND into the sibling repos' copies of this test in the same PR.
const SHARED_CORE_SHA256 = "c09c91b94cda4451741a98ff9f1ca0aa288776eb7a3dd76b78dd7bf49c3983b4";

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("shared mcp-core", () => {
  it("matches the hash pinned in every sibling repo", async () => {
    // Normalize line endings so a CRLF checkout on Windows hashes the same as
    // an LF checkout in CI.
    const normalized = (source as string).replace(/\r\n/g, "\n");
    expect(await sha256Hex(normalized)).toBe(SHARED_CORE_SHA256);
  });
});
