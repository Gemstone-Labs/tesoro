#!/usr/bin/env node
// Copies the freshly built tesoro_core IDL (target/idl/tesoro_core.json, from `anchor idl build`) into the app
// (app/src/lib/chain/idl/tesoro_core.json), keeping the app file's `errors`.
//
// Why `errors` stay: `anchor idl build` lists the errors of only ONE `#[error_code]` enum (the program has three:
// TesoroError at 6000, BasketError at 6300, MatchError at 6400), and numbers them from 6000 whatever their `offset`.
// The app reads error names from the program log and from the hand-kept lists in app/src/lib/chain/entry-errors.ts,
// which app/src/lib/chain/entry-errors.test.ts checks against programs/tesoro_core/src/error.rs.
//
// `--check` exits 1 instead of writing when the app copy differs.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const built = join(root, "target/idl/tesoro_core.json");
const app = join(root, "app/src/lib/chain/idl/tesoro_core.json");
if (!existsSync(built)) {
  console.error("target/idl/tesoro_core.json is missing: run `pnpm build:programs` first.");
  process.exit(2);
}
const next = { ...JSON.parse(readFileSync(built, "utf8")), errors: JSON.parse(readFileSync(app, "utf8")).errors };
const text = JSON.stringify(next, null, 2);
if (process.argv.includes("--check")) {
  if (readFileSync(app, "utf8") !== text) {
    console.error("app/src/lib/chain/idl/tesoro_core.json differs from the built IDL: run `node scripts/sync-idl.mjs` and commit it.");
    process.exit(1);
  }
} else {
  writeFileSync(app, text);
  console.log("app IDL updated from target/idl/tesoro_core.json");
}
