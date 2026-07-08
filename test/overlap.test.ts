import { describe, expect, it } from "vitest";
import { computeOverlap, normalizePath, pathsOverlap } from "../src/overlap.js";
import { detectConflicts } from "../src/tools.js";
import { makeClaim } from "./helpers.js";

describe("normalizePath", () => {
  it("strips leading ./ and /, trailing /, collapses //", () => {
    expect(normalizePath("./src/api/")).toBe("src/api");
    expect(normalizePath("/src//api/")).toBe("src/api");
    expect(normalizePath("  src/api  ")).toBe("src/api");
  });
});

describe("pathsOverlap", () => {
  it("(a) exact match", () => {
    expect(pathsOverlap("src/api", "src/api")).toBe(true);
    expect(pathsOverlap("./src/api", "src/api/")).toBe(true);
  });

  it("(b) directory containment, both directions", () => {
    expect(pathsOverlap("src/api", "src/api/routes.py")).toBe(true);
    expect(pathsOverlap("src/api/routes.py", "src/api")).toBe(true);
  });

  it("(c) glob match, both directions", () => {
    expect(pathsOverlap("src/**", "src/api")).toBe(true);
    expect(pathsOverlap("src/api", "src/**")).toBe(true);
    expect(pathsOverlap("*.py", "src/api/routes.py")).toBe(true);
    expect(pathsOverlap("src/api/routes.py", "*.py")).toBe(true);
  });

  it("does not over-match unrelated paths", () => {
    expect(pathsOverlap("src/api", "src/web")).toBe(false);
    expect(pathsOverlap("src/apiv2", "src/api")).toBe(false); // no false prefix
    expect(pathsOverlap("*.py", "src/api/routes.ts")).toBe(false);
  });
});

describe("computeOverlap", () => {
  it("reports the peer's contended, normalized, sorted tokens", () => {
    expect(computeOverlap(["src/**"], ["src/api", "docs/x"])).toEqual(["src/api"]);
    expect(computeOverlap(["src/a", "src/b"], ["src/b/", "./src/a"])).toEqual([
      "src/a",
      "src/b",
    ]);
  });
});

describe("detectConflicts", () => {
  const mine = { touches: ["src/api"], requires: ["lib/db"] };

  it("shared_files for touches vs peer.touches", () => {
    const claims = { peer: makeClaim({ task: "P", branch: "b", touches: ["src/api/routes.py"] }) };
    const c = detectConflicts("me", mine, claims);
    expect(c.peer.their_task).toBe("P");
    expect(c.peer.their_branch).toBe("b");
    expect(c.peer.reasons).toEqual([{ type: "shared_files", files: ["src/api/routes.py"] }]);
  });

  it("depends_on_their_wip for requires vs peer.touches", () => {
    const claims = { peer: makeClaim({ touches: ["lib/db"] }) };
    const c = detectConflicts("me", mine, claims);
    expect(c.peer.reasons).toEqual([{ type: "depends_on_their_wip", files: ["lib/db"] }]);
  });

  it("done-status peers never block", () => {
    const claims = { peer: makeClaim({ status: "done", touches: ["src/api"] }) };
    expect(detectConflicts("me", mine, claims)).toEqual({});
  });

  it("skips my own claim", () => {
    const claims = { me: makeClaim({ touches: ["src/api"] }) };
    expect(detectConflicts("me", mine, claims)).toEqual({});
  });

  it("glob containment both directions block", () => {
    expect(
      Object.keys(detectConflicts("me", { touches: ["src/**"], requires: [] }, {
        p: makeClaim({ touches: ["src/api"] }),
      })),
    ).toEqual(["p"]);
    expect(
      Object.keys(detectConflicts("me", { touches: ["src/api"], requires: [] }, {
        p: makeClaim({ touches: ["src/**"] }),
      })),
    ).toEqual(["p"]);
  });
});
