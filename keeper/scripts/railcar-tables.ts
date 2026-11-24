/**
 * Railcar's Tables pass by hand (the keeper's safety sweep runs the same `reconcileTables` once a sweep): every open Car
 * whose core car is refunded, settled or closed is closed (its rent back to whoever opened it), then a Table waiting for
 * such a car, or for one whose Car is closed already, passes it over (`skip_car`), so its later cars can ride.
 *
 * Dry run by default: reads devnet and the rollup, prints every Table and what it would send, sends nothing.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/railcar-tables.ts [--rpc <url>] [--tee-rpc <url>]
 *   ... --send --keypair <file>      the key pays the base closes and signs the rollup skips (any key may)
 */
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { carPda, configPda, decodeCarAccount, decodeConfig, decodeTable, tablePda } from "../../app/src/games/railcar/chain.ts";
import { reconcileTables, type SweepSend } from "../../app/src/games/railcar/sweep.ts";
import { settledPda } from "../../app/src/lib/chain/basket.ts";
import { connReader } from "../../app/src/lib/chain/settle-plan.ts";
import { assertCluster, clusterOf, exitOnUnknownFlag, loadKeypair, parseArgs } from "../src/cli-args.ts";

const USAGE = "usage: railcar-tables.ts [--send --keypair <file>] [--rpc <url>] [--tee-rpc <url>]";
const argv = process.argv.slice(2);
exitOnUnknownFlag(argv, { bare: ["send"], valued: ["rpc", "tee-rpc", "keypair"] }, USAGE);
const a = parseArgs(argv, ["send"]);
const send = a.flag("send");
const cluster = clusterOf("test");
const rpc = a.value("rpc") ?? cluster.solana.defaultRpc!;
const teeRpc = a.value("tee-rpc") ?? cluster.magicblock.teeRpc;
const conn = new Connection(rpc, "confirmed");
await assertCluster(conn, cluster);
const signer = send ? loadKeypair(a.need("keypair")) : Keypair.generate();
const { token } = await getAuthToken(teeRpc, signer.publicKey, async (m: Uint8Array) => nacl.sign.detached(m, signer.secretKey));
const tee = new Connection(`${teeRpc}?token=${token}`, "confirmed");

const cfgInfo = await conn.getAccountInfo(configPda());
if (!cfgInfo) throw new Error("Railcar has no config here");
const cfg = decodeConfig(cfgInfo.data);
console.log(`Railcar on ${rpc} (rollup ${teeRpc}): ${cfg.tables} Tables, next car ${cfg.nextCar}; ${send ? `sending as ${signer.publicKey.toBase58()}` : "dry run"}\n`);
for (let i = 0; i < cfg.tables; i++) {
  const info = await tee.getAccountInfo(tablePda(i), "confirmed");
  const t = info && decodeTable(info.data);
  if (!t) {
    console.log(`Table ${i}: unreadable on the rollup`);
    continue;
  }
  const carInfo = t.nextCar < cfg.nextCar ? await conn.getAccountInfo(carPda(t.nextCar)) : null;
  const car = carInfo && decodeCarAccount(carInfo.data);
  const [match, receipt] = car ? await conn.getMultipleAccountsInfo([car.tesoroMatch, settledPda(car.tesoroMatch)]) : [null, null];
  const next = t.nextCar >= cfg.nextCar ? "not opened yet" : car ? `Car open, Match ${match ? "exists" : "gone"}, receipt ${receipt ? "present" : "absent"}` : "Car closed";
  console.log(`Table ${i}: ${t.phase}, car ${t.carNo}, next car ${t.nextCar} (${next})`);
}

const sends: string[] = [];
const sendRollup = async (ixs: SweepSend["ixs"], units: number) => {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs);
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
  tx.sign(signer);
  const sig = await tee.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  await tee.confirmTransaction(sig, "confirmed");
  return sig;
};
const r = await reconcileTables({
  base: connReader(conn),
  rollup: connReader(tee),
  caller: signer.publicKey,
  send: async (s) => {
    if (!send) {
      sends.push(`${s.layer}: ${s.what}`);
      // the pass reads the Car back after a close: a dry run has not closed it, so it stops at the close
      if (s.layer === "base") throw new Error("dry run");
      return;
    }
    const sig = s.layer === "rollup" ? await sendRollup(s.ixs, s.units) : await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: s.units }), ...s.ixs), [signer], { commitment: "confirmed" });
    sends.push(`${s.layer}: ${s.what} -> ${sig}`);
  },
});
console.log(`\n${send ? "sent" : "would send"}:`);
for (const x of sends) console.log(`  ${x}`);
if (!sends.length) console.log("  nothing: every Table's next car is boarding, waiting, or not opened yet, and no open Car is done");
console.log(`closed ${r.closed.join(", ") || "-"}; skipped ${r.skipped.join(", ") || "-"}; ${send && r.failed.length ? `FAILED close ${r.failed.join(", ")}` : send ? "no failures" : `${r.failed.length} close(s) a send would make first`}`);
if (send && r.failed.length) process.exit(1);
