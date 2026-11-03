// kd-02: the bundles of keeper/scripts/kd02 as v1 transactions (SIMD-0385): wire size, account count, and whether the devnet RPC accepts them.
//   node scripts/kd02-v1-bundles.mjs <bundles.json> [more.json ...]
// Simulation runs on the real, already-moved-on state, so a program error is expected; what it shows is that the RPC took the v1 bytes.
import { readFileSync } from "node:fs";
import {
  address, AccountRole, appendTransactionMessageInstruction, createNoopSigner, createSolanaRpc, createTransactionMessage, getBase64EncodedWireTransaction, pipe,
  setTransactionMessageConfig, setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash, partiallySignTransactionMessageWithSigners,
} from "@solana/kit";

const rpc = createSolanaRpc(process.env.SOLANA_RPC ?? "https://rpc.magicblock.app/devnet");
const FUNDED = "8nHkEzKuKbetyTkotFEmStsEP9Y1rXQEc8PrkZhwwKXA"; // qsA, funded
const role = (k) => (k.isSigner ? (k.isWritable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : k.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY);

for (const file of process.argv.slice(2)) {
  for (const b of JSON.parse(readFileSync(file, "utf8"))) {
    const unique = new Set([b.feePayer, ...b.instructions.flatMap((i) => [i.program, ...i.keys.map((k) => k.pubkey)])]);
    const { value: bh } = await rpc.getLatestBlockhash().send();
    const swap = (a) => (a === b.feePayer ? FUNDED : a);
    const payer = createNoopSigner(address(FUNDED));
    let m = pipe(
      createTransactionMessage({ version: 1 }),
      (x) => setTransactionMessageFeePayerSigner(payer, x),
      (x) => setTransactionMessageLifetimeUsingBlockhash(bh, x),
      (x) => setTransactionMessageConfig({ computeUnitLimit: 1_400_000, loadedAccountsDataSizeLimit: 16 * 1024 * 1024 }, x),
    );
    for (const i of b.instructions) {
      if (i.program === "ComputeBudget111111111111111111111111111111") continue;
      m = appendTransactionMessageInstruction(
        { programAddress: address(i.program), accounts: i.keys.map((k) => ({ address: address(swap(k.pubkey)), role: role(k) })), data: Buffer.from(i.data, "base64") },
        m,
      );
    }
    let out = { name: b.name, uniqueAccounts: unique.size };
    try {
      const tx = await partiallySignTransactionMessageWithSigners(m);
      const b64 = getBase64EncodedWireTransaction(tx);
      out.v1Bytes = Buffer.from(b64, "base64").length;
      try {
        const r = await rpc.simulateTransaction(b64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }).send();
        out.rpc = "accepted";
        out.simErr = r.value.err ? JSON.stringify(r.value.err, (_, v) => (typeof v === "bigint" ? String(v) : v)) : null;
        out.units = r.value.unitsConsumed === undefined ? null : String(r.value.unitsConsumed);
      } catch (e) {
        out.rpc = `REJECTED: ${String(e.message ?? e).slice(0, 160)}`;
      }
    } catch (e) {
      out.build = `FAILED: ${String(e.message ?? e).slice(0, 200)}`;
    }
    console.log(JSON.stringify(out));
  }
}
