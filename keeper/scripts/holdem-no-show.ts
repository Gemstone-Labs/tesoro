/**
 * Devnet fixture for SP-05: two test wallets open and join a Hold'em Match, the opener runs `create_match` and then
 * exits before `delegate_match`. The keeper must `finalize` the Created table once its 5-minute start deadline passes,
 * refunding both entries.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/holdem-no-show.ts [entry Gemas: 500 (default), 100 or 1000]
 *
 * Uses the two test wallets in ~/.config/tesoro/block-puzzle-testers.json and their own-sourced Holdings (position
 * ids 11 and 12, as scripts/both-runs-closed.ts); each wallet pays its own fees.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BlockPuzzleChain, keypairSigner } from "../../app/src/games/block-puzzle/chain.ts";
import { HOLDEM_PROGRAM_ID, keypairSigner as holdemSigner } from "../../app/src/games/holdem/chain.ts";
import { settings } from "../src/env.ts";
import { buildRuntime, newConnection } from "../src/runtime.ts";

const entry = Number(process.argv[2] ?? 500);
const testers = (JSON.parse(readFileSync(join(homedir(), ".config/tesoro/block-puzzle-testers.json"), "utf8")) as number[][]).map((k) => Keypair.fromSecretKey(Uint8Array.from(k)));
const s = settings([]);
const rt = buildRuntime(s, newConnection(s.rpc, s.gpaRpc), testers[0]);

const holdingOf = (owner: PublicKey, id: number) => {
  const position = PublicKey.findProgramAddressSync([Buffer.from("position"), Buffer.from([0]), Buffer.from(Array(32).fill(id))], rt.core.programId)[0];
  const source = PublicKey.findProgramAddressSync([Buffer.from("source"), position.toBuffer(), Buffer.alloc(4)], rt.core.programId)[0];
  return BlockPuzzleChain.holding(BlockPuzzleChain.coreAccount(owner), source);
};
const holdings = [holdingOf(testers[0].publicKey, 11), holdingOf(testers[1].publicKey, 12)];
const amounts = async () => (await Promise.all(holdings.map((h) => rt.core.account.holdingState.fetch(h)))).map((h: any) => h.inner.amount.toString());

const id = BigInt(Date.now());
console.log("match id", id.toString(), "tesoro_core Match", BlockPuzzleChain.addresses(id).match.toBase58());
console.log("holdings before", (await amounts()).join(" / "));
console.log("open_match", await rt.bp.openMatch(keypairSigner(testers[0]), id, entry, [holdings[0]], HOLDEM_PROGRAM_ID));
console.log("join_match", await rt.bp.joinMatch(keypairSigner(testers[1]), id, [holdings[1]], HOLDEM_PROGRAM_ID));
console.log("holdings after entry", (await amounts()).join(" / "));
console.log("create_match", await rt.holdem.createTable(holdemSigner(testers[0]), id, testers[0].publicKey, testers[1].publicKey));
const table = await rt.holdem.readTableOnBase(id);
console.log(`table created, status ${table?.status}, start_deadline ${table?.startDeadline} (${new Date((table?.startDeadline ?? 0) * 1000).toISOString()}); exiting before delegate_match`);
process.exit(0);
