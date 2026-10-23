import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Migrations are applied by hand in number order, and branches add them in parallel: two files with one number means one runs in the wrong place or not at all. */
describe("supabase migrations", () => {
  it("each number is used once (a branch that collides takes the next free number, keeping its own files in order)", () => {
    const files = readdirSync(new URL("./migrations", import.meta.url)).filter((f) => f.endsWith(".sql"));
    const byNumber = new Map<string, string[]>();
    for (const f of files) {
      const n = f.match(/^(\d{4})_/)?.[1];
      expect(n, `${f} must start with a four-digit number and an underscore`).toBeDefined();
      byNumber.set(n!, [...(byNumber.get(n!) ?? []), f]);
    }
    expect([...byNumber.values()].filter((fs) => fs.length > 1)).toEqual([]);
  });
});
