// kd-02: does a v1 transaction (SIMD-0385) work on devnet with this repo's libraries?
//   node scripts/kd02-v1.mjs sim  <payerAddress>      simulate an unsigned v1 self-transfer (sends nothing)
//   node scripts/kd02-v1.mjs send <keyfile.json>       sign (kit, local key) and send ONE v1 self-transfer of 1 lamport
//   node scripts/kd02-v1.mjs web3 <payerAddress>       can @solana/web3.js 1.99 parse / re-serialize the same bytes?
import { readFileSync } from "node:fs";
import {
  address, appendTransactionMessageInstruction, createKeyPairSignerFromBytes, createNoopSigner, createSolanaRpc, createTransactionMessage, getBase64EncodedWireTransaction,
  getSignatureFromTransaction, partiallySignTransactionMessageWithSigners, pipe, setTransactionMessageConfig, setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash, signTransactionMessageWithSigners,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { VersionedTransaction, Transaction } from "@solana/web3.js";

const RPC = process.env.SOLANA_RPC ?? "https://rpc.magicblock.app/devnet";
const rpc = createSolanaRpc(RPC);
const [mode, arg] = process.argv.slice(2);

async function message(signer) {
  const { value: bh } = await rpc.getLatestBlockhash().send();
  return pipe(
    createTransactionMessage({ version: 1 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => setTransactionMessageConfig({ computeUnitLimit: 5_000, loadedAccountsDataSizeLimit: 64 * 1024 }, m),
    (m) => appendTransactionMessageInstruction(getTransferSolInstruction({ source: signer, destination: signer.address, amount: 1n }), m),
  );
}

if (mode === "sim" || mode === "web3") {
  const signer = createNoopSigner(address(arg));
  const tx = await partiallySignTransactionMessageWithSigners(await message(signer));
  const b64 = getBase64EncodedWireTransaction(tx);
  const bytes = Buffer.from(b64, "base64");
  console.log("v1 wire bytes", bytes.length, "first bytes (hex)", bytes.subarray(0, 12).toString("hex"));
  if (mode === "sim") {
    try {
      const r = await rpc.simulateTransaction(b64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }).send();
      console.log("simulateTransaction:", JSON.stringify(r.value, (_, v) => (typeof v === "bigint" ? String(v) : v)));
    } catch (e) {
      console.log("simulateTransaction REJECTED:", String(e.message ?? e).slice(0, 400), e.cause ? String(e.cause.message ?? e.cause).slice(0, 300) : "");
    }
  } else {
    for (const [name, f] of [
      ["VersionedTransaction.deserialize", () => VersionedTransaction.deserialize(bytes)],
      ["Transaction.from", () => Transaction.from(bytes)],
    ]) {
      try {
        const t = f();
        let again = "n/a";
        try {
          again = Buffer.from(t.serialize()).equals(bytes) ? "round-trips" : "does NOT round-trip";
        } catch (e) {
          again = `serialize failed: ${String(e.message ?? e).slice(0, 80)}`;
        }
        console.log(name, "parsed, version", t.version ?? "legacy", "| static keys", t.message?.staticAccountKeys?.length, "| instructions", t.message?.compiledInstructions?.length, "|", again);
      } catch (e) {
        console.log(name, "FAILED:", String(e.message ?? e).slice(0, 200));
      }
    }
  }
}

if (mode === "send") {
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(readFileSync(arg, "utf8"))));
  const signed = await signTransactionMessageWithSigners(await message(signer));
  const b64 = getBase64EncodedWireTransaction(signed);
  console.log("signer", signer.address, "v1 wire bytes", Buffer.from(b64, "base64").length);
  const sig = getSignatureFromTransaction(signed);
  try {
    const out = await rpc.sendTransaction(b64, { encoding: "base64", preflightCommitment: "confirmed" }).send();
    console.log("sendTransaction OK", out, "expected", sig);
  } catch (e) {
    console.log("sendTransaction REJECTED:", String(e.message ?? e).slice(0, 500), e.cause ? JSON.stringify(e.cause, (_, v) => (typeof v === "bigint" ? String(v) : v)).slice(0, 600) : "");
    process.exit(0);
  }
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const st = (await rpc.getSignatureStatuses([sig]).send()).value[0];
    if (st) {
      console.log("status", JSON.stringify(st, (_, v) => (typeof v === "bigint" ? String(v) : v)));
      break;
    }
  }
  const tx = await rpc.getTransaction(sig, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }).send().catch((e) => ({ error: String(e.message ?? e).slice(0, 300) }));
  console.log("getTransaction:", JSON.stringify(tx, (_, v) => (typeof v === "bigint" ? String(v) : v)).slice(0, 900));
}
