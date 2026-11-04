/** Who sent each base-layer transaction that touched a core Match (fee payer + instruction names). cd app && ../keeper/node_modules/.bin/tsx scripts/kd20-who.mts <match key> */
import { Connection } from "@solana/web3.js";
const { matchAddressOf } = await import("@/lib/chain/match-id");
const coreIdl = (await import("@/lib/chain/idl/tesoro_core.json", { with: { type: "json" } })).default as { instructions: { name: string; discriminator: number[] }[] };
const conn = new Connection(process.env.RPC ?? "https://rpc.magicblock.app/devnet", "confirmed");
const mk = matchAddressOf(process.argv[2])!;
const sigs = await conn.getSignaturesForAddress(mk, { limit: 100 });
const names = new Map(coreIdl.instructions.map((i) => [Buffer.from(i.discriminator).toString("hex"), i.name]));
for (const s of sigs.reverse()) {
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) continue;
  const m = tx.transaction.message;
  const keys = m.getAccountKeys({ accountKeysFromLookups: tx.meta?.loadedAddresses });
  const ixs = m.compiledInstructions.map((i) => names.get(Buffer.from(i.data.subarray(0, 8)).toString("hex")) ?? keys.get(i.programIdIndex)!.toBase58().slice(0, 4)).filter((n) => !["Comp", "1111"].includes(n));
  console.log(s.signature, "payer", keys.get(0)!.toBase58().slice(0, 6), "fee", tx.meta?.fee, ixs.join("+"), tx.meta?.err ? "ERR" : "");
}
