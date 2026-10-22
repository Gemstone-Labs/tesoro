import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { art } from "./art";

/** Every `/art/...` path in the art map, however deeply nested. */
function paths(v: unknown): string[] {
  if (typeof v === "string") return v.startsWith("/art/") ? [v] : [];
  if (v && typeof v === "object") return Object.values(v).flatMap(paths);
  return [];
}

describe("art map", () => {
  it("points only at files in public/ (renamed art must be renamed here, and pages must read it from here)", () => {
    const missing = paths(art).filter((p) => !existsSync(join(__dirname, "../../public", p)));
    expect(missing).toEqual([]);
  });
});
