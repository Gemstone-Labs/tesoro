import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

// The keeper runs as ES modules: `import * as anchor` there loses anchor.BN and friends
// (CommonJS interop), which broke the first Season payout. Use `import anchor from "@coral-xyz/anchor"`.
describe("keeper imports", () => {
  it("never imports @coral-xyz/anchor as a namespace", () => {
    const dir = new URL(".", import.meta.url);
    const bad = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /import \* as \w+ from "@coral-xyz\/anchor"/.test(readFileSync(new URL(f, dir), "utf8")));
    assert.deepEqual(bad, [], `use \`import anchor from "@coral-xyz/anchor"\` in: ${bad.join(", ")}`);
  });
});
