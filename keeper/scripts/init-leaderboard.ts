/**
 * Sets up the Leaderboard on devnet (`init_leaderboard`, admin only): extends Config, creates the pool Account and sets
 * the fee. Run after `tesoro_core` is upgraded. Idempotent: does nothing when Config already has a pool at that fee.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/init-leaderboard.ts [--bps 100] [--dry-run]
 *
 * `--dry-run` only simulates the transaction. Also says whether `~/.config/tesoro/oracle.json` is the Config's
 * `oracle_authority` (the key the keeper's season job signs with).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import coreIdl from "../../app/src/lib/chain/idl/tesoro_core.json" with { type: "json" };
import { CONFIG, POOL_ACCOUNT, POOL_AUTHORITY, parseLeaderboardTerms } from "../../app/src/lib/chain/leaderboard.ts";
import { keeperCluster, scriptRpc } from "../src/cluster.ts";

const rpc = scriptRpc();
const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const bpsAt = argv.indexOf("--bps");
const bps = bpsAt >= 0 ? Number(argv[bpsAt + 1]) : 100;
if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw new Error("--bps must be an integer from 0 to 5000");

const read = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
const admin = read(join(homedir(), ".config/solana/dev-2026-10.json"));
const c = new Connection(rpc, "confirmed");

const info = await c.getAccountInfo(CONFIG);
if (!info) throw new Error("Config does not exist: tesoro_core is not initialised on this cluster");
// Config: disc 8, bump 1, admin 32, oracle_authority 32.
const configAdmin = new PublicKey(info.data.subarray(9, 41));
const oracleAuthority = new PublicKey(info.data.subarray(41, 73));
console.log(`config ${CONFIG.toBase58()} (${info.data.length} bytes), admin ${configAdmin.toBase58()}`);
if (!configAdmin.equals(admin.publicKey)) throw new Error(`the signer ${admin.publicKey.toBase58()} is not the Config admin`);

const oraclePath = process.env.KEEPER_ORACLE ?? join(homedir(), ".config/tesoro/oracle.json");
if (existsSync(oraclePath)) {
  const oracle = read(oraclePath).publicKey;
  console.log(oracle.equals(oracleAuthority) ? `oracle key ${oracle.toBase58()} IS the Config's oracle_authority: the keeper can record and pay seasons` : `WARNING: oracle key ${oracle.toBase58()} is NOT the Config's oracle_authority (${oracleAuthority.toBase58()}): the keeper's season job would be refused`);
} else {
  console.log(`no oracle key at ${oraclePath}; Config's oracle_authority is ${oracleAuthority.toBase58()}`);
}

const terms = parseLeaderboardTerms(info.data);
if (terms.recipient && terms.bps === bps) {
  console.log(`already set up: pool ${terms.recipient.toBase58()}, fee ${terms.bps} bps, since ${new Date(terms.since * 1000).toISOString()}. Nothing to do.`);
  process.exit(0);
}
console.log(terms.recipient ? `leaderboard exists at ${terms.bps} bps; changing the fee to ${bps} bps` : `leaderboard not set up yet; initialising at ${bps} bps`);

const provider = new AnchorProvider(c, { publicKey: admin.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t }, {});
const core = new Program(coreIdl as any, provider);
const ix = await core.methods
  .initLeaderboard(bps)
  .accountsPartial({ admin: admin.publicKey, config: CONFIG, poolAuthority: POOL_AUTHORITY, poolAccount: POOL_ACCOUNT, systemProgram: SystemProgram.programId } as any)
  .instruction();
const tx = new Transaction().add(ix);

if (dryRun) {
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  const sim = await c.simulateTransaction(tx);
  console.log("dry run:", sim.value.err ? `WOULD FAIL ${JSON.stringify(sim.value.err)}` : `would succeed, ${sim.value.unitsConsumed} CU`);
  for (const l of sim.value.logs ?? []) console.log("  ", l);
  process.exit(sim.value.err ? 1 : 0);
}
const sig = await sendAndConfirmTransaction(c, tx, [admin]);
console.log("init_leaderboard done", sig);
const after = parseLeaderboardTerms((await c.getAccountInfo(CONFIG))!.data);
console.log(`pool ${after.recipient?.toBase58()}, fee ${after.bps} bps, since ${new Date(after.since * 1000).toISOString()}`);
