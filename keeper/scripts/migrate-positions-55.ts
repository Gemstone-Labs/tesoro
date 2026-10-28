/**
 * Ticket 55 deploy-day run: upgrade tesoro_core (Positions gain `stake_rate_high`, 235 -> 243 bytes) and migrate every 235-byte
 * Position in the same run, with the keeper paused, so settlement and Redeem never meet a Position the new program cannot read.
 * The step-1 release (app and keeper read both layouts, "updating" copy) must already be live. Test mode (devnet) only; the
 * founder's word is needed for the upgrade. Order and reasoning: design-v4 6.3, docs/deployments.md ("Ticket 55").
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/migrate-positions-55.ts [--read-rpc <url>] [--mainnet-rpc <url>] [--so <tesoro_core.so>]
 *   pnpm --filter @tesoro/keeper exec tsx scripts/migrate-positions-55.ts --send --keypair ~/.config/solana/dev-2026-10.json --so <tesoro_core.so> [--rpc <url>] [--keeper-host vps]
 *
 * Dry run (default) reads only: other upgrades in flight, the admin's balance against what the run needs, the mainnet stake-Position
 * count, the devnet Positions by layout, legacy stake Locks whose holders are owed more than their custody, and the commands `--send`
 * would run. It signs nothing and needs no key.
 *
 * `--send` steps: (1) refuse if `solana program` runs elsewhere (the Dungeons & Moles session shares the deployer key) or the deployer
 * is short; (2) refuse unless mainnet has 0 stake Positions; (3) stop the keeper; (4) report over-claimed legacy Locks; (5) extend the
 * program if the new .so needs it, write the buffer and upgrade; (6) migrate_position every 235-byte Position; (7) refuse to go on
 * unless no 235-byte stake Position is left; (8) start the keeper again and check its health. A re-run skips what is done.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, sendAndConfirmTransaction, type Keypair } from "@solana/web3.js";
import coreIdl from "../../app/src/lib/chain/idl/tesoro_core.json" with { type: "json" };
import { loadKeypair, parseArgs } from "../src/cli-args.ts";
import { BPF_LOADER_UPGRADEABLE } from "../src/kit.ts";
import { classify, excessClaims, gates, migrateIx, migrateTxs, requiredLamports, type PositionRow } from "../src/migrate-positions.ts";
import { CORE, coreProgram } from "../src/retire-old.ts";

const args = parseArgs(process.argv.slice(2), ["send"]);
const send = args.flag("send");
const readRpc = args.value("read-rpc") ?? "https://api.devnet.solana.com";
const sendRpc = args.value("rpc") ?? "https://rpc.magicblock.app/devnet";
const mainnetRpc = args.value("mainnet-rpc") ?? "https://api.mainnet-beta.solana.com";
const keeperHost = args.value("keeper-host") ?? "vps";
const so = args.value("so");
const reader = new Connection(readRpc, "confirmed");
const coder = new BorshAccountsCoder(coreIdl as unknown as Idl);
const disc = Buffer.from((coreIdl as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((a) => a.name === "PositionState")!.discriminator);

const lamportsSol = (l: bigint) => `${(Number(l) / 1e9).toFixed(4)} SOL`;

async function positions(c: Connection): Promise<PositionRow[]> {
  const lists = await Promise.all(
    [235, 243].map((dataSize) => c.getProgramAccounts(CORE, { filters: [{ dataSize }, { memcmp: { offset: 0, bytes: disc.toString("base64"), encoding: "base64" } }] })),
  );
  return lists.flat().map((r) => ({ pubkey: r.pubkey, data: Buffer.from(r.account.data) }));
}

/** `pgrep -A -fa "solana program"` lines (none when nothing runs). */
function otherUpgrades(): string[] {
  try {
    return execFileSync("pgrep", ["-A", "-fa", "solana program"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** What the upgrade needs: the buffer's rent for the new .so, and how many bytes the ProgramData must grow first (0 when none). */
async function upgradeNeeds(c: Connection): Promise<{ bufferLamports: bigint; extendBytes: number; soBytes: number | null; dataBytes: number }> {
  const programData = PublicKey.findProgramAddressSync([CORE.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];
  const data = await c.getAccountInfo(programData);
  if (!data) throw new Error(`ProgramData ${programData.toBase58()} not found on ${readRpc}`);
  const dataBytes = data.data.length - 45;
  const soBytes = so ? statSync(so).size : null;
  const size = soBytes ?? dataBytes;
  const bufferLamports = BigInt(await c.getMinimumBalanceForRentExemption(size + 37));
  // Devnet refuses an extend of less than 10,240 bytes.
  const extendBytes = soBytes && soBytes > dataBytes ? Math.max(soBytes - dataBytes, 10_240) : 0;
  return { bufferLamports, extendBytes, soBytes, dataBytes };
}

function run(cmd: string, argv: string[]): string {
  console.log(`  $ ${cmd} ${argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);
  if (!send) return "";
  return execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function keeper(action: "stop" | "start") {
  run("ssh", [keeperHost, `systemctl --user ${action} tesoro-keeper && systemctl --user is-active tesoro-keeper || true`]);
}

async function migrateAll(deployer: Keypair, keys: PublicKey[]) {
  const conn = new Connection(sendRpc, "confirmed");
  const program = coreProgram();
  let done = 0;
  for (const group of migrateTxs(keys)) {
    const infos = await reader.getMultipleAccountsInfo(group);
    const todo = group.filter((_, i) => infos[i]?.data.length === 235);
    if (!todo.length) continue;
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 30_000 * todo.length }));
    for (const k of todo) tx.add(await migrateIx(program, deployer.publicKey, k));
    const sig = await sendAndConfirmTransaction(conn, tx, [deployer], { commitment: "confirmed" });
    done += todo.length;
    console.log(`  migrated ${done}/${keys.length}  ${sig}`);
  }
}

async function main() {
  console.log(`${send ? "SEND" : "DRY RUN (reads only)"}  read ${readRpc}${send ? `  send ${sendRpc}` : ""}`);
  const config = await reader.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("config")], CORE)[0]);
  if (!config) throw new Error("tesoro_core Config not found");
  const admin = new PublicKey(coder.decode("Config", config.data).admin);
  const deployer = send ? loadKeypair(args.need("keypair")) : null;
  if (deployer && !deployer.publicKey.equals(admin)) throw new Error(`--keypair is not the Config admin ${admin.toBase58()}`);
  if (send && !so) throw new Error("--send needs --so <tesoro_core.so> (built from the commit being shipped)");

  const before = classify(await positions(reader));
  const needs = await upgradeNeeds(reader);
  const balance = BigInt(await reader.getBalance(admin));
  const mainnetRows = await positions(new Connection(mainnetRpc, "confirmed")).catch((e) => {
    throw new Error(`mainnet read failed (${mainnetRpc}): ${String(e).slice(0, 120)}`);
  });
  const mainnetStake = mainnetRows.filter((r) => r.data.readBigUInt64LE(122 + (r.data[122] === 1 ? 5 : 1) + 16 + 42) !== 0n).length;
  const migrationRent = BigInt((await reader.getMinimumBalanceForRentExemption(243)) - (await reader.getMinimumBalanceForRentExemption(235)));
  const required = requiredLamports(before.legacy.length, needs.bufferLamports, migrationRent);
  const busy = otherUpgrades();

  console.log(`\n1. Upgrades in flight: ${busy.length ? busy.join(" | ") : "none"}`);
  console.log(`   Admin (deployer) ${admin.toBase58()}: ${lamportsSol(balance)}; the run needs ${lamportsSol(required)} (buffer ${lamportsSol(needs.bufferLamports)} for ${needs.soBytes ?? needs.dataBytes} bytes, then ${before.legacy.length} migrations at ${migrationRent} lamports of rent each)`);
  console.log(`2. Mainnet stake Positions (${mainnetRpc}): ${mainnetStake} of ${mainnetRows.length} Positions`);
  console.log(`   Devnet Positions: ${before.legacy.length} of 235 bytes (${before.legacyStake.length} stake), ${before.current} of 243 bytes`);
  const over = excessClaims(before.legacyStake);
  console.log(`4. Legacy stake Locks owing holders more than their custody: ${over.length ? over.map((e) => `${e.position.toBase58()} +${e.excess} shares`).join(", ") : "none"}`);
  if (needs.extendBytes) console.log(`   The new .so is ${needs.soBytes} bytes, ProgramData holds ${needs.dataBytes}: extend by ${needs.extendBytes}`);
  console.log(`   Migration: ${migrateTxs(before.legacy.map((r) => r.pubkey)).length} transactions of up to 10 Positions`);

  const refused = gates({ otherUpgrades: busy, deployerLamports: balance, required, mainnetStake });
  if (refused.length) {
    console.log(`\nREFUSED:\n- ${refused.join("\n- ")}`);
    process.exit(1);
  }

  console.log(`\nSteps${send ? "" : " --send would run"}:`);
  console.log("3. Stop the keeper");
  keeper("stop");
  console.log("5. Upgrade tesoro_core");
  const key = send ? args.need("keypair") : "<deployer keypair>";
  if (needs.extendBytes) run("solana", ["program", "extend", CORE.toBase58(), String(needs.extendBytes), "-u", sendRpc, "-k", key]);
  const out = run("solana", ["program", "write-buffer", so ?? "<tesoro_core.so>", "-u", sendRpc, "-k", key]);
  const buffer = send ? /Buffer: (\w+)/.exec(out)?.[1] : "<buffer>";
  if (!buffer) throw new Error(`write-buffer printed no buffer address: ${out}`);
  run("solana", ["program", "deploy", "--buffer", buffer, "--program-id", CORE.toBase58(), "--upgrade-authority", key, "-u", sendRpc, "-k", key]);
  console.log(`6. migrate_position for ${before.legacy.length} Positions`);
  if (deployer) await migrateAll(deployer, before.legacy.map((r) => r.pubkey));
  if (send) {
    const after = classify(await positions(reader));
    console.log(`7. Left of 235 bytes: ${after.legacy.length} (${after.legacyStake.length} stake); 243 bytes: ${after.current}`);
    if (after.legacyStake.length) {
      console.log("REFUSED: a 235-byte stake Position is left; the keeper stays stopped. Re-run to finish the sweep.");
      process.exit(1);
    }
  } else console.log("7. Check: no 235-byte stake Position left, else stop here with the keeper stopped");
  console.log("8. Start the keeper and check its health");
  keeper("start");
  run("ssh", [keeperHost, "sleep 20; curl -s 127.0.0.1:8787/healthz"]);
  console.log("\nThe app copy for RateBelowPeak / YieldCapReached shipped with the step-1 release: nothing to push for it.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
