/** Cranks one native Position (permissionless; the deployer pays) until its Debt is 0:  tsx scripts/yield-crank.ts <position> */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { accrueNativeYieldIx, fetchNativeInfo } from "../../app/src/lib/chain/native.ts";
import { covered, live } from "../../app/src/lib/chain/ledger.ts";

const c = new Connection(process.env.RPC_URL ?? "https://rpc.magicblock.app/devnet", "confirmed");
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".config/solana/dev-2026-10.json"), "utf8"))));
const position = new PublicKey(process.argv[2]);
for (;;) {
  try {
    const info = (await fetchNativeInfo(c, position))!;
    const sig = await sendAndConfirmTransaction(c, new Transaction().add(accrueNativeYieldIx(position, info.openAdvance)), [payer]);
    const after = (await fetchNativeInfo(c, position))!;
    const s = after.source!.math;
    const debt = live(s) - covered(s);
    console.log(new Date().toISOString(), sig.slice(0, 12), "debt", String(debt), "open", after.openAdvance);
    if (debt === 0n) break;
  } catch (e) {
    console.log("retry:", String(e).slice(0, 100));
  }
  await new Promise((r) => setTimeout(r, 20_000));
}
