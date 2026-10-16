/**
 * Sets up Tesoro's Treasury on devnet and funds it: `init_treasury` (admin only; creates the Treasury, its Account and
 * the simSOL vault, or changes the rates) and `fund_treasury` (moves simSOL from the admin into the vault so Instant
 * Redeems can be paid before any Yield Fee has accrued). Run after `tesoro_core` is upgraded, before the keeper restarts.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/fund-treasury.ts [--shares 10000000000] [--yield-bps 2000] [--instant-bps 2500] [--no-fund] [--dry-run]
 *
 * `--shares` is simSOL base units (9 decimals; default 10 simSOL). When the admin holds less, the SIMULATED faucet is
 * used first (10 simSOL, once per cooldown). `--dry-run` only simulates the transactions.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { createSimSolAtaIx, faucetIx, fetchNativeMarket, fundTreasuryIx, initTreasuryIx } from "../../app/src/lib/chain/native.ts";
import { DEFAULT_INSTANT_FEE_BPS, DEFAULT_YIELD_FEE_BPS } from "../../app/src/lib/chain/yield.ts";
import { keeperCluster, scriptRpc } from "../src/cluster.ts";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: number) => {
  const at = argv.indexOf(name);
  return at >= 0 ? Number(argv[at + 1]) : fallback;
};
const dryRun = argv.includes("--dry-run");
const shares = BigInt(arg("--shares", 10_000_000_000));
const yieldBps = arg("--yield-bps", DEFAULT_YIELD_FEE_BPS);
const instantBps = arg("--instant-bps", DEFAULT_INSTANT_FEE_BPS);
for (const bps of [yieldBps, instantBps]) if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw new Error("fee rates must be integers from 0 to 5000 bps");

const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/solana/dev-2026-10.json"), "utf8"))));
const c = new Connection(scriptRpc(), "confirmed");

async function send(label: string, ixs: TransactionInstruction[]) {
  const tx = new Transaction().add(...ixs);
  if (dryRun) {
    tx.feePayer = admin.publicKey;
    tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
    const sim = await c.simulateTransaction(tx);
    console.log(`${label} (dry run):`, sim.value.err ? `WOULD FAIL ${JSON.stringify(sim.value.err)}` : `would succeed, ${sim.value.unitsConsumed} CU`);
    for (const l of sim.value.logs ?? []) console.log("  ", l);
    return;
  }
  console.log(label, await sendAndConfirmTransaction(c, tx, [admin]));
}

await send(`init_treasury (Yield Fee ${yieldBps} bps, Instant Redeem Fee ${instantBps} bps)`, [initTreasuryIx(admin.publicKey, yieldBps, instantBps)]);

if (!argv.includes("--no-fund")) {
  const held = (await fetchNativeMarket(c, admin.publicKey)).simSol;
  if (held < shares) {
    console.log(`admin holds ${Number(held) / 1e9} simSOL, needs ${Number(shares) / 1e9}: using the faucet first`);
    await send("faucet", [createSimSolAtaIx(admin.publicKey, admin.publicKey), faucetIx(admin.publicKey)]);
  }
  await send(`fund_treasury (${Number(shares) / 1e9} simSOL)`, [fundTreasuryIx(admin.publicKey, shares)]);
}
const after = await fetchNativeMarket(c, admin.publicKey);
console.log(after.treasury ? `treasury: Yield Fee ${after.treasury.yieldFeeBps} bps, Instant Redeem Fee ${after.treasury.instantFeeBps} bps, vault ${Number(after.treasuryShares ?? 0n) / 1e9} simSOL` : "treasury: not set up");
