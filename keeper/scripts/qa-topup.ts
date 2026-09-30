// QA (F-05): a direct simSOL top-up of a native Position's vault must not reduce its Debt.
//   tsx scripts/qa-topup.ts <secret-key-base58 file with the owner's dev key> [simSOL to send, default 1]
// Reads the owner's Position with Debt, sends the top-up straight to the vault token account, cranks
// accrue_native_yield and prints cumulative yield / vault balance / Debt before and after.
import { readFileSync } from "node:fs";
import bs58 from "../../app/node_modules/bs58/src/cjs/index.cjs";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { settings } from "../src/env.ts";
import { buildRuntime, newConnection } from "../src/runtime.ts";
import { accountPda, accrueNativeYieldIx, fetchNativeInfo, projectedDebtGemas, fetchNativeMarket, simSolAta, sourcePda, TOKEN_PROGRAM_ID, vaultPda } from "../../app/src/lib/chain/native.ts";

const [secretFile, amountArg = "1"] = process.argv.slice(2);
const owner = Keypair.fromSecretKey(((bs58 as any).default ?? bs58).decode(readFileSync(secretFile, "utf8").trim()));
const s = settings();
const conn = newConnection(s.rpc, s.gpaRpc);
const rt = buildRuntime(s, conn, owner);
const acct = accountPda(owner.publicKey);
const rows: any[] = await rt.core.account.positionState.all();
const mine = rows.filter((r) => Buffer.from(r.account.inner.owner).equals(acct.toBuffer()));
const withDebt = mine.find((r) => r.account.inner.openAdvance !== null && r.account.inner.openAdvance !== undefined);
if (!withDebt) throw new Error("owner has no Position with Debt");
const position: PublicKey = withDebt.publicKey;
const open = Number(withDebt.account.inner.openAdvance);

const show = async (label: string) => {
  const info = await fetchNativeInfo(conn, position);
  const market = await fetchNativeMarket(conn, owner.publicKey);
  const debt = projectedDebtGemas(info!.source?.math ?? null, info!.vaultShares, info!.redeemedUnits, info!.principalLamports, market.pool, Date.now());
  console.log(label, JSON.stringify({ cumulativeYield: String(info!.cumulativeYield), freeYield: String(info!.freeYield), vaultShares: String(info!.vaultShares), source: info!.source && { issued: String(info!.source.math.issued), returned: String(info!.source.math.returned), yieldUnits: String(info!.source.math.yieldUnits) }, projectedDebtGemas: String(debt) }));
};

console.log("position", position.toBase58(), "open advance", open);
await show("before");
const amount = BigInt(Math.round(Number(amountArg) * 1e9));
const data = Buffer.alloc(9);
data[0] = 3; // spl-token Transfer
data.writeBigUInt64LE(amount, 1);
const transfer = new TransactionInstruction({
  programId: TOKEN_PROGRAM_ID,
  keys: [
    { pubkey: simSolAta(owner.publicKey), isSigner: false, isWritable: true },
    { pubkey: vaultPda(position), isSigner: false, isWritable: true },
    { pubkey: owner.publicKey, isSigner: true, isWritable: false },
  ],
  data,
});
const sig1 = await rt.bp.sendBase(rt.signer, [transfer]);
console.log("top-up sent", sig1);
await show("after top-up");
const sig2 = await rt.bp.sendBase(rt.signer, [accrueNativeYieldIx(position, open)]);
console.log("accrue sent", sig2);
await show("after accrue");
process.exit(0);
