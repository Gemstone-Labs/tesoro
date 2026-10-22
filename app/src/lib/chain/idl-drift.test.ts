import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";

const root = join(process.cwd(), "..");

describe("the app's copy of the program", () => {
  // A glob never exists, so this once skipped on every machine: name a file the build always writes.
  const built = join(root, "target/idl/tesoro_core.json");

  it.skipIf(!existsSync(built))("the app IDL is the one the program builds", () => {
    try {
      execFileSync("node", [join(root, "scripts/sync-idl.mjs"), "--check"], { stdio: "pipe" });
    } catch (e) {
      throw new Error(`An IDL in the app is out of date with its program. Regenerate: \`pnpm build:programs\` (it runs \`anchor idl build\` and then scripts/sync-idl.mjs), or \`node scripts/sync-idl.mjs\` after a build, and commit app/src/lib/chain/idl/*.json.\n${(e as { stderr?: Buffer }).stderr?.toString() ?? ""}`);
    }
  });
});
