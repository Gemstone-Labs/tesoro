/**
 * Retires the money accounts of the world before the yield-by-math reset (ticket 11), after `tesoro_core` is upgraded:
 * old per-Position custodies and vaults (their simSOL goes back to the Position owner), Positions, Sources, Holdings (their
 * Gemas leave the Account totals), Offers, expired Requests and the old-sized Treasury. Admin only; the program refuses
 * anything of the current layout. Run order and the reasoning: docs/deployments.md ("Retire the old accounts").
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/retire-old-accounts.ts [--read-rpc <url>] [--dry-run]
 *   pnpm --filter @tesoro/keeper exec tsx scripts/retire-old-accounts.ts --send --keypair ~/.config/solana/dev-2026-10.json [--rpc <url>] [--allow-live-matches] [--kinds custody,position,...]
 *
 * Dry run (default) reads the chain (default https://api.devnet.solana.com, which serves getProgramAccounts) and prints the
 * inventory, the phases, the first transaction of each kind and the simSOL that returns to its owners; it sends nothing and
 * needs no key. `--send` sends each phase through `--rpc` (default https://rpc.magicblock.app/devnet), re-reads the chain
 * before each phase, and is idempotent: a re-run only touches what is still there. It refuses to start while a Match is
 * Open or Active (they credit Holdings that are about to disappear) unless `--allow-live-matches`. Test mode only.
 */
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import coreIdl from "../../app/src/lib/chain/idl/tesoro_core.json" with { type: "json" };
import { loadKeypair, parseArgs } from "../src/cli-args.ts";
import { BATCH, CORE, KINDS, ataOf, batches, buildIx, coreProgram, planAll, planPhase, typeOf, type Item, type Kind, type Row, type Snapshot } from "../src/retire-old.ts";

const args = parseArgs(process.argv.slice(2), ["send", "dry-run", "allow-live-matches"]);
const send = args.flag("send");
if (send && args.flag("dry-run")) throw new Error("--send and --dry-run exclude each other");
const readRpc = args.value("read-rpc") ?? "https://api.devnet.solana.com";
const sendRpc = args.value("rpc") ?? "https://rpc.magicblock.app/devnet";
const only = args.value("kinds")?.split(",").map((k) => {
  if (!(KINDS as string[]).includes(k)) throw new Error(`--kinds: unknown ${k}; expected ${KINDS.join(", ")}`);
  return k as Kind;
});
const reader = new Connection(readRpc, "confirmed");
const coder = new BorshAccountsCoder(coreIdl as unknown as Idl);
const program = coreProgram();

async function retry<T>(label: string, f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 6) throw e;
      const wait = 3000 * 2 ** Math.min(i, 4);
      console.log(`  ${label}: ${String(e).slice(0, 90)}; retry in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

async function readSnapshot(): Promise<Snapshot> {
  const all = await retry("getProgramAccounts", () => reader.getProgramAccounts(CORE));
  const rows = new Map<string, Row>(all.map((a) => [a.pubkey.toBase58(), { pubkey: a.pubkey, data: a.account.data, lamports: a.account.lamports }]));
  const custodies = [...rows.values()].filter((r) => typeOf(r.data) === "NativeCustody" && r.data.length >= 170);
  const vaultKeys = custodies.map((r) => new PublicKey(r.data.subarray(138, 170)));
  const ataKeys = [...new Set(custodies.map((r) => ataOf(new PublicKey(r.data.subarray(42, 74)))))];
  const fetchMany = async (keys: PublicKey[]) => {
    const out = [];
    for (let i = 0; i < keys.length; i += 90) out.push(...(await retry("getMultipleAccountsInfo", () => reader.getMultipleAccountsInfo(keys.slice(i, i + 90)))));
    return out;
  };
  const vaults = new Map<string, bigint>();
  (await fetchMany(vaultKeys)).forEach((info, i) => {
    if (info && info.data.length >= 72) vaults.set(vaultKeys[i].toBase58(), info.data.readBigUInt64LE(64));
  });
  const atas = new Set<string>();
  (await fetchMany(ataKeys)).forEach((info, i) => info && atas.add(ataKeys[i].toBase58()));
  const slot = await retry("getSlot", () => reader.getSlot());
  const now = (await retry("getBlockTime", () => reader.getBlockTime(slot))) ?? Math.floor(Date.now() / 1000);
  return { rows, vaults, atas, now };
}

function liveMatches(s: Snapshot): { key: string; status: string; stale: boolean }[] {
  const out = [];
  for (const r of s.rows.values()) {
    if (typeOf(r.data) !== "MatchState") continue;
    const status = r.data[8 + 1 + 8 + 32 + 8 + 68]; // 0 Open, 1 Active
    if (status === 0 || status === 1) out.push({ key: r.pubkey.toBase58(), status: status === 0 ? "Open" : "Active", stale: r.data.length < 915 });
  }
  return out;
}

function inventory(s: Snapshot) {
  const by = new Map<string, number>();
  for (const r of s.rows.values()) by.set(`${typeOf(r.data) ?? "?"}:${r.data.length}`, (by.get(`${typeOf(r.data) ?? "?"}:${r.data.length}`) ?? 0) + 1);
  console.log(`inventory (${s.rows.size} tesoro_core accounts):`);
  for (const [k, v] of [...by].sort()) console.log(`  ${k.padEnd(28)} ${v}`);
  const matches = liveMatches(s);
  console.log(`Open/Active Matches: ${matches.length}${matches.length ? "  " + matches.map((m) => `${m.key} (${m.status}${m.stale ? ", old size" : ""})`).join(", ") : ""}`);
  return matches;
}

function summarize(items: Item[]) {
  const n = (k: Kind) => items.filter((i) => i.kind === k).length;
  const sim = items.filter((i) => i.kind === "custody").reduce((a, i) => a + (i.amount ?? 0n), 0n);
  const gemas = items.filter((i) => i.kind === "holding").reduce((a, i) => a + (i.amount ?? 0n), 0n);
  const atas = items.filter((i) => i.createsAta).length;
  return `${KINDS.map((k) => `${n(k)} ${k}`).join(", ")}; ${Number(sim) / 1e9} simSOL back to owners (${atas} new simSOL accounts); ${gemas} Gemas removed`;
}

function totalsCheck(s: Snapshot) {
  const holdings = [...s.rows.values()].filter((r) => typeOf(r.data) === "HoldingState");
  const held = holdings.reduce((a, r) => a + r.data.readBigUInt64LE(74), 0n);
  let totals = 0n;
  for (const r of s.rows.values()) if (typeOf(r.data) === "TesoroAccount") totals += r.data.readBigUInt64LE(8 + 1 + 32 + 20) + r.data.readBigUInt64LE(8 + 1 + 32 + 20 + 8);
  return { holdings: holdings.length, held, totals };
}

const sendBatch = async (conn: Connection, admin: ReturnType<typeof loadKeypair>, group: Item[]) => {
  const ixs = await Promise.all(group.map((i) => buildIx(program, admin.publicKey, i)));
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs);
  return sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed" });
};

const snap = await readSnapshot();
const matches = inventory(snap);
const chk = totalsCheck(snap);
console.log(`Gemas: ${chk.held} in ${chk.holdings} Holdings, ${chk.totals} in Account totals${chk.held === chk.totals ? " (they match)" : " (MISMATCH: Match escrow or an unread layout)"}`);

if (!send) {
  const plan = planAll(snap);
  const all = plan.phases.flat();
  console.log(`\nplan: ${summarize(all)}`);
  plan.phases.forEach((items, i) => {
    const groups = KINDS.map((k) => ({ k, g: items.filter((x) => x.kind === k) })).filter((x) => x.g.length);
    console.log(`phase ${i + 1}: ${groups.map((x) => `${x.g.length} ${x.k} in ${batches(x.g, BATCH[x.k]).length} tx`).join(", ") || "nothing"}`);
  });
  if (plan.skipped.length) {
    console.log(`\nleft alone (${plan.skipped.length}):`);
    for (const s of plan.skipped.slice(0, 20)) console.log(`  ${s.kind} ${s.key}: ${s.reason}`);
    if (plan.skipped.length > 20) console.log(`  ... and ${plan.skipped.length - 20} more`);
  }
  console.log("\nfirst transaction of each kind (instruction accounts):");
  for (const k of KINDS) {
    const item = all.find((i) => i.kind === k);
    if (!item) continue;
    const ix = await buildIx(program, new PublicKey("11111111111111111111111111111111"), item);
    console.log(`  ${k}: ${item.key.toBase58()}${item.amount !== undefined ? ` amount ${item.amount}` : ""}${item.createsAta ? " (creates owner simSOL account)" : ""}`);
    console.log(`    accounts: ${ix.keys.map((m) => m.pubkey.toBase58().slice(0, 6)).join(" ")}  data: ${ix.data.toString("hex")}`);
  }
  console.log("\ndry run: nothing was sent. Run with --send --keypair <admin file> after the tesoro_core upgrade.");
  process.exit(0);
}

const admin = loadKeypair(args.need("keypair"));
const config = await retry("config", () => reader.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("config")], CORE)[0]));
if (!config) throw new Error("tesoro_core Config not found");
const cfgAdmin = (coder.decode("Config", config.data) as { admin: PublicKey }).admin;
if (!cfgAdmin.equals(admin.publicKey)) throw new Error(`the key ${admin.publicKey.toBase58()} is not the Config admin ${cfgAdmin.toBase58()}`);
if (matches.length && !args.flag("allow-live-matches")) throw new Error("Open/Active Matches exist (listed above); settle or refund them first, or pass --allow-live-matches");
const conn = new Connection(sendRpc, "confirmed");
let sent = 0;
let failed = 0;
for (const phase of [1, 2, 3, 4] as const) {
  const s = phase === 1 ? snap : await readSnapshot();
  const { items } = planPhase(s, phase);
  const todo = items.filter((i) => !only || only.includes(i.kind));
  console.log(`\nphase ${phase}: ${summarize(todo)}`);
  for (const k of KINDS) {
    for (const group of batches(todo.filter((i) => i.kind === k), BATCH[k])) {
      try {
        const sig = await retry(`send ${k}`, () => sendBatch(conn, admin, group));
        sent++;
        console.log(`  ${k} x${group.length}: ${sig}`);
      } catch (e) {
        failed++;
        console.log(`  ${k} x${group.length} FAILED: ${String(e).slice(0, 300)}`);
      }
    }
  }
}
const end = await readSnapshot();
const left = planAll(end);
const endChk = totalsCheck(end);
console.log(`\nsummary: ${sent} transactions sent, ${failed} failed. Still to retire: ${summarize(left.phases.flat())}`);
console.log(`left alone: ${left.skipped.length}${left.skipped.length ? " (" + [...new Set(left.skipped.map((x) => x.kind + ": " + x.reason))].join("; ") + ")" : ""}`);
console.log(`Gemas: ${endChk.held} in ${endChk.holdings} Holdings, ${endChk.totals} in Account totals`);
if (failed) process.exitCode = 1;
