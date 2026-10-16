/**
 * Admin: pays Tesoro's earned revenue out of the Treasury (ADR 0010). `set_treasury_company` names the wallet
 * `withdraw_treasury` pays (needed once), then `withdraw_treasury(amount)` pays `amount` SOL of the Treasury balance
 * (unminted Yield Fee earned plus the vault's simSOL) into that wallet's simSOL account, minting the shortfall.
 *
 * TEST MODE ONLY (simSOL, `withdraw_treasury`): the builders are the app's, bound to the repo's tesoro_core id, so a different
 * `--program tesoro_core=` and `--cluster mainnet` are refused. The mainnet withdrawal (`withdraw_treasury_stake`, jitoSOL) has
 * a builder in app/src/lib/chain/stake.ts but no script yet.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/withdraw-treasury.ts --keypair <admin file> [--rpc <url>] [--company <pubkey>] [--amount <SOL>] [--send]
 *
 * Dry run by default: it prints the balance and simulates the transactions. Only `--send` signs and sends them.
 * `--company` runs `set_treasury_company` first (the withdrawal then pays that wallet, whose simSOL account is created
 * in the same transaction). Without `--company` the Treasury's current company is used.
 */
import { PublicKey, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { treasuryBalanceUnits } from "../../app/src/lib/chain/fees.ts";
import { adminSigning, parseArgs, programOverrides } from "../src/cli-args.ts";
import { TESORO_CORE_ID, createSimSolAtaIx, fetchNativeMarket, rateAt, setTreasuryCompanyIx, speedupOf, treasuryPda, withdrawTreasuryIx } from "../../app/src/lib/chain/native.ts";

const args = parseArgs(process.argv.slice(2), ["send"]);
const value = (name: string) => args.value(name.slice(2));
const send = args.flag("send");
const companyArg = value("--company");
const amountArg = value("--amount");

const signing = await adminSigning(args, programOverrides(args.values("program")));
if (signing.cluster.id !== "test") throw new Error("withdraw-treasury is test mode only (simSOL); the mainnet withdrawal has no script yet");
if (!signing.program.equals(TESORO_CORE_ID)) throw new Error("this test-mode script builds with the app's tesoro_core id; --program tesoro_core=<other> is not supported");
const { keypair: admin, conn: c } = signing;

async function run(label: string, ixs: TransactionInstruction[]) {
  const tx = new Transaction().add(...ixs);
  if (send) {
    console.log(label, await sendAndConfirmTransaction(c, tx, [admin]));
    return;
  }
  tx.feePayer = admin.publicKey;
  tx.recentBlockhash = (await c.getLatestBlockhash()).blockhash;
  const sim = await c.simulateTransaction(tx);
  console.log(`${label} (dry run):`, sim.value.err ? `WOULD FAIL ${JSON.stringify(sim.value.err)}` : `would succeed, ${sim.value.unitsConsumed} CU`);
  for (const l of sim.value.logs ?? []) console.log("  ", l);
}

const market = await fetchNativeMarket(c, admin.publicKey);
if (!market.treasury || !market.treasuryClaim || market.treasuryShares === null) throw new Error("the Treasury or the shared native custody is not set up");
const balance = treasuryBalanceUnits({
  ...market.treasuryClaim,
  vaultShares: market.treasuryShares,
  rate: rateAt(market.pool),
  speedup: speedupOf(market.pool),
  nowSec: Math.floor(Date.now() / 1000),
});
console.log(`Treasury balance: ${Number(balance) / 1e9} SOL (the program checks the exact figure)`);

let company = companyArg ? new PublicKey(companyArg) : null;
if (!company) {
  // Treasury.company: disc 8, bumps 3, two u16 rates, account, vault, four u64 counters, then the company key.
  const t = await c.getAccountInfo(treasuryPda(), "confirmed");
  const key = t ? new PublicKey(t.data.subarray(8 + 3 + 2 + 2 + 64 + 4 * 8, 8 + 3 + 2 + 2 + 64 + 4 * 8 + 32)) : null;
  company = key && !key.equals(PublicKey.default) ? key : null;
}
if (!company) throw new Error("no company wallet set: pass --company <pubkey>");

if (companyArg) await run(`set_treasury_company ${company.toBase58()}`, [setTreasuryCompanyIx(admin.publicKey, company)]);
if (amountArg) {
  const units = BigInt(Math.round(Number(amountArg) * 1e9));
  if (units <= 0n || units > balance) throw new Error(`amount must be above 0 and at most the balance (${Number(balance) / 1e9} SOL)`);
  await run(`withdraw_treasury ${amountArg} SOL to ${company.toBase58()}`, [createSimSolAtaIx(admin.publicKey, company), withdrawTreasuryIx(admin.publicKey, company, units)]);
}
if (!send) console.log("dry run: nothing was sent; add --send to sign and send");
