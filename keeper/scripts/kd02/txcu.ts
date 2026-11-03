// kd-02: real compute and size of past devnet transactions. `getTransaction` meta gives the CU each top-level instruction used.
//   tsx scripts/kd02/txcu.ts <address> [signatureLimit=60] [filter,regex=.]
// For each successful transaction whose instruction names match the filter: signature, version, wire bytes, accounts
// (static + loaded from lookup tables), signers, and CU per top-level instruction.
import { PublicKey } from "@solana/web3.js";
import { conn, retry } from "./lib.ts";

const [addr, limitArg, filterArg] = process.argv.slice(2);
const limit = Number(limitArg ?? 60);
const filter = new RegExp(process.env.KD_FILTER ?? filterArg ?? ".", "i");

const sigs = await retry(() => conn.getSignaturesForAddress(new PublicKey(addr), { limit }, "confirmed"));
console.log(`# ${addr}: ${sigs.length} signatures`);
const rows: any[] = [];
for (const s of sigs) {
  if (s.err) continue;
  const tx = await retry(() => conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })).catch(() => null);
  if (!tx?.meta) continue;
  const logs = tx.meta.logMessages ?? [];
  const top: { program: string; name: string; cu: number }[] = [];
  const stack: { program: string; name: string }[] = [];
  for (const l of logs) {
    let m = /^Program (\w+) invoke \[(\d+)\]/.exec(l);
    if (m) {
      stack.push({ program: m[1], name: "" });
      continue;
    }
    m = /^Program log: Instruction: (\w+)/.exec(l);
    if (m && stack.length) {
      if (!stack[stack.length - 1].name) stack[stack.length - 1].name = m[1];
      continue;
    }
    m = /^Program (\w+) consumed (\d+) of/.exec(l);
    if (m && stack.length === 1) top.push({ program: stack[0].program, name: stack[0].name, cu: Number(m[2]) });
    if (/^Program \w+ (success|failed)/.test(l)) stack.pop();
  }
  const names = top.map((t) => t.name || t.program.slice(0, 4)).join("+");
  if (!filter.test(names)) continue;
  const msg: any = tx.transaction.message;
  const staticKeys = (msg.staticAccountKeys ?? msg.accountKeys).length;
  const loaded = (tx.meta.loadedAddresses?.writable.length ?? 0) + (tx.meta.loadedAddresses?.readonly.length ?? 0);
  const alts = msg.addressTableLookups?.length ?? 0;
  rows.push({ sig: s.signature, ver: tx.version, static: staticKeys, loaded, alts, sigs: tx.transaction.signatures.length, total: tx.meta.computeUnitsConsumed, ix: top.filter((t) => t.name).map((t) => `${t.name}:${t.cu}`).join(" ") });
}
for (const r of rows) console.log(JSON.stringify(r));
