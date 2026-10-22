#!/usr/bin/env node
// Copies every freshly built IDL that the app keeps a copy of (target/idl/<program>.json, from `anchor idl build`) into
// app/src/lib/chain/idl/<program>.json, keeping each app file's `errors`.
//
// Why `errors` stay: `anchor idl build` lists the errors of only ONE `#[error_code]` enum (the program has three:
// TesoroError at 6000, BasketError at 6300, MatchError at 6400), and numbers them from 6000 whatever their `offset`.
// The app reads error names from the program log and from the hand-kept lists in app/src/lib/chain/entry-errors.ts,
// which app/src/lib/chain/entry-errors.test.ts checks against programs/tesoro_core/src/error.rs.
//
// `--check` exits 1 instead of writing when the app copy differs.
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "app/src/lib/chain/idl");
const check = process.argv.includes("--check");
const programs = readdirSync(appDir).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
let drift = false;
for (const name of programs) {
  const built = join(root, "target/idl", `${name}.json`);
  const app = join(appDir, `${name}.json`);
  if (!existsSync(built)) {
    console.error(`target/idl/${name}.json is missing: run \`pnpm build:programs\` first.`);
    process.exit(2);
  }
  const next = { ...JSON.parse(readFileSync(built, "utf8")), errors: JSON.parse(readFileSync(app, "utf8")).errors };
  const text = JSON.stringify(next, null, 2);
  if (readFileSync(app, "utf8") === text) continue;
  if (check) {
    console.error(`app/src/lib/chain/idl/${name}.json differs from the built IDL: run \`node scripts/sync-idl.mjs\` and commit it.`);
    drift = true;
  } else {
    writeFileSync(app, text);
    console.log(`app IDL updated from target/idl/${name}.json`);
  }
}
process.exit(drift ? 1 : 0);
