import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_NAMES } from "./entry-errors";

const root = join(process.cwd(), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Variant names of a plain `#[error_code]` enum, in order. */
function enumNames(source: string, name: string): string[] {
  const body = new RegExp(`pub enum ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? "";
  return [...body.matchAll(/^ {4}([A-Z]\w*),$/gm)].map((m) => m[1]);
}

describe("the app's copy of the program", () => {
  const built = join(root, "target/idl/tesoro_core.json");

  it.skipIf(!existsSync(built))("the app IDL is the one the program builds", () => {
    try {
      execFileSync("node", [join(root, "scripts/sync-idl.mjs"), "--check"], { stdio: "pipe" });
    } catch (e) {
      throw new Error(`The tesoro_core IDL in the app is out of date with the program. Regenerate: \`pnpm build:programs\` (it runs \`anchor idl build\` and then scripts/sync-idl.mjs), or \`node scripts/sync-idl.mjs\` after a build, and commit app/src/lib/chain/idl/tesoro_core.json.\n${(e as { stderr?: Buffer }).stderr?.toString() ?? ""}`);
    }
  });

  // `anchor idl build` lists only one error enum, so the names the app maps by number are kept by hand. They must follow the program.
  it("the error names the app maps by number follow the program's enums", () => {
    const errors = read("programs/tesoro_core/src/error.rs");
    const regen = "Update the lists in app/src/lib/chain/entry-errors.ts to the enum order in programs/tesoro_core/src/error.rs and ledger/mod.rs.";
    expect(ERROR_NAMES.basket, regen).toEqual(enumNames(errors, "BasketError"));
    expect(ERROR_NAMES.match, regen).toEqual(enumNames(errors, "MatchError"));
    const core = [...read("programs/tesoro_core/src/ledger/mod.rs").split("core_errors! {")[1].matchAll(/^ {4}(\w+) => "/gm)].map((m) => m[1]);
    expect(ERROR_NAMES.core, regen).toEqual(core);
  });
});
