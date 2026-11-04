/** Sends begin_match for an existing Block Burst Match as fresh wallet N and prints the full error. */
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
const [key, who] = process.argv.slice(2);
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".cache/tesoro-tmp/kd-20/fresh-keys.json"), "utf8"))[Number(who ?? 0)]));
const s = keypairSigner(kp);
const a = (await chain.readAssignment(matchAddressOf(key)!))!;
const t = await chain.readTable(s, a);
try { console.log("ok", await chain.beginMatch(s, a, t!)); } catch (e) { console.log("ERR", String((e as Error).message ?? e).slice(0, 1500)); if ((e as { logs?: string[] }).logs) console.log((e as { logs: string[] }).logs.join("\n")); }
process.exit(0);
