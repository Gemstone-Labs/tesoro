/** Prints the Assignment and the rollup Table of a Block Burst Match. cd app && ../keeper/node_modules/.bin/tsx scripts/kd20-table.mts <match key> */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
const { getChain } = await import("@/lib/chain/client");
const { BlockBurstChain, keypairSigner } = await import("@/games/block-puzzle/live-chain");
const { matchAddressOf } = await import("@/lib/chain/match-id");
const bp = (await import("@/lib/chain/idl/block_puzzle.json", { with: { type: "json" } })).default;
const core = (await import("@/lib/chain/idl/tesoro_core.json", { with: { type: "json" } })).default;
const chain = new BlockBurstChain(bp as never, core, { base: getChain().base });
const mk = matchAddressOf(process.argv[2])!;
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".cache/tesoro-tmp/kd-20/fresh-keys.json"), "utf8"))[0]));
const a = await chain.readAssignment(mk);
console.log("assignment", JSON.stringify(a, (_k, v) => (typeof v === "bigint" ? v.toString() : v?.toBase58 ? v.toBase58() : v?.words ? v.toString() : v)));
if (a) {
  const t = await chain.readTable(keypairSigner(kp), a);
  console.log("table", JSON.stringify(t, (_k, v) => (typeof v === "bigint" ? v.toString() : v?.toBase58 ? v.toBase58() : v?.words ? v.toString() : v)));
  const b = await chain.readTableOnBase(a);
  console.log("base", JSON.stringify(b, (_k, v) => (typeof v === "bigint" ? v.toString() : v?.toBase58 ? v.toBase58() : v?.words ? v.toString() : v)));
}
process.exit(0);
