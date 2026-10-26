/**
 * Retires the tesoro_bridge records of layouts the current program cannot read (BridgePosition 172/188 B, Claim 129 B,
 * VaultTreasury 77 B) with `retire_legacy_account` (admin only, rent to the admin). Run after the bridge upgrade that adds it.
 * An old record whose vault is a CURRENT vault (a registered PeerConfig) is left alone and listed.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/retire-bridge-accounts.ts [--read-rpc <url>]
 *   pnpm --filter @tesoro/keeper exec tsx scripts/retire-bridge-accounts.ts --send --keypair <bridge admin file> [--rpc <url>]
 *
 * Dry run (default) reads the chain, sends nothing and needs no key. `--send` re-reads before it sends and is idempotent: a
 * re-run only touches what is still there.
 */
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { loadKeypair, parseArgs } from "../src/cli-args.ts";
import { BRIDGE, STORE } from "../src/lz.ts";
import { BRIDGE_BATCH, BRIDGE_KINDS, buildBridgeIx, planBridge, type BridgeItem } from "../src/retire-bridge.ts";

const args = parseArgs(process.argv.slice(2), ["send"]);
const send = args.flag("send");
const reader = new Connection(args.value("read-rpc") ?? "https://api.devnet.solana.com", "confirmed");
const sendRpc = args.value("rpc") ?? "https://rpc.magicblock.app/devnet";

async function retry<T>(label: string, f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 6 || (e as { logs?: string[] }).logs) throw e;
      const wait = 3000 * 2 ** Math.min(i, 4);
      console.log(`  ${label}: ${String(e).slice(0, 90)}; retry in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const read = async () => {
  const all = await retry("getProgramAccounts", () => reader.getProgramAccounts(BRIDGE));
  return all.map((a) => ({ pubkey: a.pubkey, data: a.account.data, lamports: a.account.lamports }));
};

function describe(rows: Awaited<ReturnType<typeof read>>) {
  const plan = planBridge(rows);
  console.log(`${rows.length} bridge accounts; ${plan.items.length} old records to close; ${plan.held.length} held back; ${plan.left} current or other (left alone)`);
  for (const kind of BRIDGE_KINDS) {
    const of = plan.items.filter((i) => i.kind === kind);
    const sizes = [...new Set(of.map((i) => i.size))].sort((a, b) => a - b).join("/");
    const rent = of.reduce((sum, i) => sum + i.lamports, 0);
    console.log(`  ${kind.padEnd(15)} ${String(of.length).padStart(3)} (${sizes || "-"} B), ${rent / 1e9} SOL rent`);
  }
  console.log(`  total rent to the admin: ${plan.items.reduce((s, i) => s + i.lamports, 0) / 1e9} SOL; ${plan.unpaidClaims} old Claims had units not yet paid (they could never be paid by the current program)`);
  const heldBy = BRIDGE_KINDS.map((k) => `${plan.held.filter((h) => h.kind === k).length} ${k}`).join(", ");
  console.log(`  held back because their vault is a current vault: ${heldBy}`);
  for (const h of plan.held) console.log(`    ${h.kind} ${h.key.toBase58()} (${h.size} B) vault 0x${h.vault.slice(24)}`);
  return plan;
}

const rows = await read();
const plan = describe(rows);
if (!send) {
  console.log("\ndry run: nothing was sent. Add --send --keypair <bridge admin file> after the bridge upgrade.");
  process.exit(0);
}

const admin = loadKeypair(args.need("keypair"));
const store = await retry("Store", () => reader.getAccountInfo(STORE));
if (!store) throw new Error("bridge Store not found");
const storeAdmin = new PublicKey(store.data.subarray(8, 40));
if (!storeAdmin.equals(admin.publicKey)) throw new Error(`the key ${admin.publicKey.toBase58()} is not the bridge admin ${storeAdmin.toBase58()}`);
const conn = new Connection(sendRpc, "confirmed");
let sent = 0;
let failed = 0;
const groups: BridgeItem[][] = [];
for (let i = 0; i < plan.items.length; i += BRIDGE_BATCH) groups.push(plan.items.slice(i, i + BRIDGE_BATCH));
for (const group of groups) {
  try {
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...group.map((i) => buildBridgeIx(admin.publicKey, i)));
    const sig = await retry("send", () => sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed" }));
    sent++;
    console.log(`  x${group.length}: ${sig}`);
  } catch (e) {
    failed++;
    console.log(`  x${group.length} FAILED: ${String(e).slice(0, 300)}`);
    const logs = (e as { logs?: string[] }).logs;
    if (logs) console.log(logs.map((l) => `      ${l}`).join("\n"));
  }
}
console.log(`\nsummary: ${sent} transactions sent, ${failed} failed. Left to retire:`);
describe(await read());
if (failed) process.exitCode = 1;
