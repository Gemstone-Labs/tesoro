/**
 * Sets up Tesoro's Treasury on devnet and funds it: `init_treasury` (admin only; creates the Treasury, its Account and
 * the simSOL vault, or changes the rates) and `fund_treasury` (moves simSOL from the admin into the vault so Instant
 * Redeems can be paid before any Yield Fee has accrued). Run after `tesoro_core` is upgraded, before the keeper restarts.
 *
 * TEST MODE ONLY (simSOL): the instruction builders are the app's, which are bound to the repo's tesoro_core id, so a
 * `--program tesoro_core=` that differs is refused and so is `--cluster mainnet` (mainnet uses `init_treasury_stake` in
 * launch-admin.ts).
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/fund-treasury.ts --keypair <admin file> [--rpc <url>] [--program tesoro_core=<ID>] [--shares 10000000000] [--yield-bps 2000] [--instant-bps 2500] [--no-fund] [--dry-run]
 *
 * `--shares` is simSOL base units (9 decimals; default 10 simSOL). When the admin holds less, the SIMULATED faucet is
 * used first (10 simSOL, once per cooldown). `--dry-run` only simulates the transactions.
 */
import { Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { adminSigning, parseArgs, programOverrides } from "../src/cli-args.ts";
import { TESORO_CORE_ID, createSimSolAtaIx, faucetIx, fetchNativeMarket, fundTreasuryIx, initTreasuryIx } from "../../app/src/lib/chain/native.ts";
import { DEFAULT_INSTANT_FEE_BPS, DEFAULT_YIELD_FEE_BPS } from "../../app/src/lib/chain/yield.ts";

const argv = process.argv.slice(2);
const args = parseArgs(argv, ["dry-run", "no-fund"]);
const arg = (name: string, fallback: number) => (args.value(name.slice(2)) !== undefined ? Number(args.value(name.slice(2))) : fallback);
const dryRun = args.flag("dry-run");
const shares = BigInt(arg("--shares", 10_000_000_000));
const yieldBps = arg("--yield-bps", DEFAULT_YIELD_FEE_BPS);
const instantBps = arg("--instant-bps", DEFAULT_INSTANT_FEE_BPS);
for (const bps of [yieldBps, instantBps]) if (!Number.isInteger(bps) || bps < 0 || bps > 5000) throw new Error("fee rates must be integers from 0 to 5000 bps");

const signing = await adminSigning(args, programOverrides(args.values("program")));
if (signing.cluster.id !== "test") throw new Error("fund-treasury is test mode only (simSOL); on mainnet use launch-admin.ts");
if (!signing.program.equals(TESORO_CORE_ID)) throw new Error("this test-mode script builds with the app's tesoro_core id; --program tesoro_core=<other> is not supported");
const { keypair: admin, conn: c } = signing;

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

if (!args.flag("no-fund")) {
  const held = (await fetchNativeMarket(c, admin.publicKey)).simSol;
  if (held < shares) {
    console.log(`admin holds ${Number(held) / 1e9} simSOL, needs ${Number(shares) / 1e9}: using the faucet first`);
    await send("faucet", [createSimSolAtaIx(admin.publicKey, admin.publicKey), faucetIx(admin.publicKey)]);
  }
  await send(`fund_treasury (${Number(shares) / 1e9} simSOL)`, [fundTreasuryIx(admin.publicKey, shares)]);
}
const after = await fetchNativeMarket(c, admin.publicKey);
console.log(after.treasury ? `treasury: Yield Fee ${after.treasury.yieldFeeBps} bps, Instant Redeem Fee ${after.treasury.instantFeeBps} bps, vault ${Number(after.treasuryShares ?? 0n) / 1e9} simSOL` : "treasury: not set up");
