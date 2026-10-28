/**
 * Ticket 55 deploy-day run: upgrade tesoro_core (Positions gain `stake_rate_high`, 235 -> 243 bytes) and migrate every 235-byte
 * Position in the same run, with the keeper paused, so settlement and Redeem never meet a Position the new program cannot read.
 * The step-1 release (app and keeper read both layouts, "updating" copy) must already be live. Test mode (devnet) only; the
 * founder's word is needed for the upgrade. Order and reasoning: design-v4 6.3, docs/deployments.md ("Ticket 55").
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/migrate-positions-55.ts [--so <tesoro_core.so>] [--read-rpc <url>] [--rpc <url>] [--mainnet-rpc <url>] [--mainnet-program <id>] [--keeper-host vps]
 *   pnpm --filter @tesoro/keeper exec tsx scripts/migrate-positions-55.ts --send --keypair ~/.config/solana/dev-2026-10.json --so <tesoro_core.so> [...]
 *
 * Dry run (default) reads only and needs no key: it runs every check below and prints the commands `--send` would run.
 *
 * Checks, all before the keeper stops: every RPC is on the cluster it is meant for (genesis hash); no other program upgrade runs
 * on this machine or on the keeper host (the Dungeons & Moles session shares the deployer key); tesoro_core's upgrade authority
 * and the Config admin are the deployer; the deployer holds the buffer rent, the extend rent, write-buffer's fees and every
 * migration; mainnet has 0 stake Positions.
 *
 * `--send` steps: (3) stop the keeper and require systemd to say `inactive`; (4) report legacy Locks owing holders more than their
 * custody; (5) unless ProgramData already holds this .so (a re-run): extend if the .so is larger, check again that no other
 * upgrade runs, write the buffer and upgrade; (6) migrate every 235-byte Position, scanning again until a scan finds none of any
 * kind; (7) start the keeper, require `active` and a /healthz that shows a finished pass.
 *
 * A failure after the keeper stops prints the keeper's state, whether the program was upgraded and the deployer's buffers. Before
 * the upgrade the old program is still live, so the keeper is started again; after it the keeper stays stopped and a re-run of the
 * same command (which skips the upgrade) finishes the sweep.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, sendAndConfirmTransaction, type Keypair } from "@solana/web3.js";
import coreIdl from "../../app/src/lib/chain/idl/tesoro_core.json" with { type: "json" };
import { loadKeypair, parseArgs } from "../src/cli-args.ts";
import { BPF_LOADER_UPGRADEABLE } from "../src/kit.ts";
import {
  MIGRATIONS_PER_TX,
  PROGRAM_DATA_HEADER,
  UPGRADE_PATTERN,
  classify,
  excessClaims,
  gates,
  healthError,
  isStake,
  keeperStateError,
  migrateIx,
  migrateTx,
  migrateTxs,
  requiredLamports,
  soDeployed,
  upgradeAuthorityOf,
  upgradesFrom,
  type PositionRow,
} from "../src/migrate-positions.ts";
import { CORE, coreProgram } from "../src/retire-old.ts";

const args = parseArgs(process.argv.slice(2), ["send"]);
const send = args.flag("send");
const readRpc = args.value("read-rpc") ?? "https://api.devnet.solana.com";
const sendRpc = args.value("rpc") ?? "https://rpc.magicblock.app/devnet";
const mainnetRpc = args.value("mainnet-rpc") ?? "https://api.mainnet-beta.solana.com";
const mainnetProgram = new PublicKey(args.value("mainnet-program") ?? CORE.toBase58());
const keeperHost = args.value("keeper-host") ?? "vps";
const soPath = args.value("so");
const so = soPath ? readFileSync(soPath) : null;
const reader = new Connection(readRpc, "confirmed");
const sender = new Connection(sendRpc, "confirmed");
const coder = new BorshAccountsCoder(coreIdl as unknown as Idl);
const disc = Buffer.from((coreIdl as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((a) => a.name === "PositionState")!.discriminator);
const programData = PublicKey.findProgramAddressSync([CORE.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];
const MAX_SWEEPS = 5;

const lamportsSol = (l: bigint) => `${(Number(l) / 1e9).toFixed(4)} SOL`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(what: string, f: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= tries) throw new Error(`${what} failed ${tries} times: ${String(e).slice(0, 200)}`);
      await sleep(2_000 * i);
    }
  }
}

/** Every PositionState of `program` on `c`, of both layouts. */
const positions = (c: Connection, program = CORE): Promise<PositionRow[]> =>
  retry("Position scan", async () => {
    const lists = await Promise.all(
      [235, 243].map((dataSize) => c.getProgramAccounts(program, { filters: [{ dataSize }, { memcmp: { offset: 0, bytes: disc.toString("base64"), encoding: "base64" } }] })),
    );
    return lists.flat().map((r) => ({ pubkey: r.pubkey, data: Buffer.from(r.account.data) }));
  });

const readProgramData = () =>
  retry("ProgramData read", async () => {
    const info = await reader.getAccountInfo(programData);
    if (!info) throw new Error(`ProgramData ${programData.toBase58()} not found on ${readRpc}`);
    return info;
  });

/** Other program upgrades on this machine and on the keeper host (builds and deploys run on both); a failed check is a refusal. */
function otherUpgrades(): string[] {
  const local = spawnSync("pgrep", ["-a", "-A", "-f", UPGRADE_PATTERN], { encoding: "utf8" });
  const remote = spawnSync("ssh", [keeperHost, `pgrep -a -A -f '${UPGRADE_PATTERN}'`], { encoding: "utf8" });
  return [
    ...upgradesFrom("this machine", local.status, local.stdout ?? "", local.stderr || local.error?.message || ""),
    ...upgradesFrom(keeperHost, remote.status, remote.stdout ?? "", remote.stderr || remote.error?.message || ""),
  ];
}

/** What the upgrade needs: the buffer's rent for the new .so, the extend (bytes and rent; 0 when ProgramData has room). */
async function upgradeNeeds(data: { data: Buffer; lamports: number }, deployed: boolean) {
  const dataBytes = data.data.length - PROGRAM_DATA_HEADER;
  const soBytes = so?.length ?? dataBytes;
  if (deployed) return { bufferLamports: 0n, extendBytes: 0, extendLamports: 0n, soBytes, dataBytes };
  const bufferLamports = BigInt(await reader.getMinimumBalanceForRentExemption(soBytes + 37));
  // Devnet refuses an extend of less than 10,240 bytes.
  const extendBytes = so && soBytes > dataBytes ? Math.max(soBytes - dataBytes, 10_240) : 0;
  const extendLamports = extendBytes ? BigInt(Math.max(0, (await reader.getMinimumBalanceForRentExemption(data.data.length + extendBytes)) - data.lamports)) : 0n;
  return { bufferLamports, extendBytes, extendLamports, soBytes, dataBytes };
}

/** Prints a command and, with --send, runs it and prints its output; a non-zero exit throws. */
function run(cmd: string, argv: string[]): string {
  console.log(`  $ ${cmd} ${argv.map((a) => (/[\s|()]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  if (!send) return "";
  const out = execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  if (out.trim()) console.log(out.trim().replace(/^/gm, "    "));
  return out;
}

/** `systemctl --user is-active tesoro-keeper` on the keeper host (it exits non-zero when inactive: only its answer counts). */
function keeperState(): string {
  const r = spawnSync("ssh", [keeperHost, "systemctl --user is-active tesoro-keeper"], { encoding: "utf8" });
  return (r.stdout ?? "").trim() || `(no answer: ${(r.stderr || r.error?.message || "").trim()})`;
}

async function stopKeeper() {
  run("ssh", [keeperHost, "systemctl --user stop tesoro-keeper"]);
  if (!send) return console.log(`  then require \`systemctl --user is-active tesoro-keeper\` to print inactive`);
  const err = keeperStateError("inactive", keeperState());
  if (err) throw new Error(`${err} after the stop: not upgrading while it may still crank`);
  console.log("  keeper: inactive");
}

async function startKeeper(): Promise<string | null> {
  run("ssh", [keeperHost, "systemctl --user start tesoro-keeper"]);
  if (!send) {
    console.log("  then require `active`, and `curl -sf 127.0.0.1:8787/healthz` alive with a finished pass (up to 3 minutes)");
    return null;
  }
  let state = "";
  for (let i = 0; i < 10 && keeperStateError("active", (state = keeperState())); i++) await sleep(3_000);
  const stateErr = keeperStateError("active", state);
  if (stateErr) return stateErr;
  console.log("  keeper: active");
  let problem: string | null = "no /healthz answer";
  for (let i = 0; i < 18 && problem; i++) {
    await sleep(10_000);
    const r = spawnSync("ssh", [keeperHost, "curl -sf 127.0.0.1:8787/healthz"], { encoding: "utf8" });
    const body = (r.stdout ?? "").trim();
    problem = r.status === 0 ? healthError(body) : `curl -sf exit ${r.status} (unhealthy or not listening)`;
    console.log(`  /healthz: ${body || "(none)"}${problem ? `  (${problem})` : ""}`);
  }
  return problem;
}

/** One migrate_position per 235-byte Position, a batch per transaction; a failed batch is logged and left to the next scan. */
async function migrateAll(deployer: Keypair, keys: PublicKey[]): Promise<number> {
  const program = coreProgram();
  let done = 0;
  for (const group of migrateTxs(keys)) {
    const infos = await retry("Position read", () => reader.getMultipleAccountsInfo(group));
    const todo = group.filter((_, i) => infos[i]?.data.length === 235);
    if (!todo.length) continue;
    const tx = migrateTx(await Promise.all(todo.map((k) => migrateIx(program, deployer.publicKey, k))));
    try {
      const sig = await sendAndConfirmTransaction(sender, tx, [deployer], { commitment: "confirmed" });
      done += todo.length;
      console.log(`    migrated ${todo.length}  ${sig}`);
    } catch (e) {
      console.log(`    batch of ${todo.length} failed, the next scan retries it: ${String(e).slice(0, 200)}`);
    }
  }
  return done;
}

/** Migrates until a scan finds no 235-byte Position of any kind (settle and Redeem need every Position readable). */
async function sweep(deployer: Keypair | null, first: PositionRow[]) {
  let legacy = first;
  for (let round = 1; ; round++) {
    const c = classify(legacy);
    console.log(`  scan ${round}: ${c.legacy.length} of 235 bytes (${c.legacyStake.length} stake), ${c.current} of 243 bytes`);
    if (!c.legacy.length) return;
    if (!deployer) {
      console.log(`  --send migrates them in ${migrateTxs(c.legacy.map((r) => r.pubkey)).length} transactions of up to ${MIGRATIONS_PER_TX}, then scans again until none is left`);
      return;
    }
    if (round > MAX_SWEEPS) throw new Error(`${c.legacy.length} Positions are still 235 bytes after ${MAX_SWEEPS} sweeps: ${c.legacy.map((r) => r.pubkey.toBase58()).join(", ")}`);
    await migrateAll(deployer, c.legacy.map((r) => r.pubkey));
    legacy = await positions(reader);
  }
}

async function main() {
  console.log(`${send ? "SEND" : "DRY RUN (reads only)"}  read ${readRpc}  send ${sendRpc}  mainnet ${mainnetRpc}`);
  if (send && !so) throw new Error("--send needs --so <tesoro_core.so> (built from the commit being shipped)");
  const [readGenesis, sendGenesis, mainnetGenesis] = await Promise.all(
    [reader, sender, new Connection(mainnetRpc, "confirmed")].map((c) => retry("genesis read", () => c.getGenesisHash())),
  );
  const config = await reader.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("config")], CORE)[0]);
  if (!config) throw new Error("tesoro_core Config not found");
  const admin = new PublicKey(coder.decode("Config", config.data).admin);
  const keypair = send ? loadKeypair(args.need("keypair")) : null;
  const deployer = keypair?.publicKey ?? admin;

  const data = await readProgramData();
  const deployed = so ? soDeployed(data.data, so) : false;
  const needs = await upgradeNeeds(data, deployed);
  const before = await positions(reader);
  const classified = classify(before);
  const balance = BigInt(await reader.getBalance(deployer));
  const mainnetHasProgram = !!(await retry("mainnet program read", () => new Connection(mainnetRpc, "confirmed").getAccountInfo(mainnetProgram)));
  const mainnetRows = mainnetHasProgram ? await positions(new Connection(mainnetRpc, "confirmed"), mainnetProgram) : [];
  const mainnetStake = mainnetRows.filter(isStake).length;
  const migrationRent = BigInt((await reader.getMinimumBalanceForRentExemption(243)) - (await reader.getMinimumBalanceForRentExemption(235)));
  const required = requiredLamports({ positions: classified.legacy.length, ...needs, migrationRent });
  const upgrades = otherUpgrades();
  const authority = upgradeAuthorityOf(data.data);

  console.log(`\n1. Clusters by genesis: read ${readGenesis}, send ${sendGenesis}, mainnet ${mainnetGenesis}`);
  console.log(`   Upgrades in flight (this machine, ${keeperHost}): ${upgrades.length ? upgrades.join(" | ") : "none"}`);
  console.log(`   Upgrade authority ${authority?.toBase58() ?? "none"}; Config admin ${admin.toBase58()}; deployer ${deployer.toBase58()}`);
  console.log(
    `   Deployer: ${lamportsSol(balance)}; the run needs ${lamportsSol(required)} (buffer ${lamportsSol(needs.bufferLamports)} for ${needs.soBytes} bytes, extend ${lamportsSol(needs.extendLamports)}, write-buffer fees, then ${classified.legacy.length} migrations at ${migrationRent} lamports of rent each)`,
  );
  console.log(`2. Mainnet stake Positions (${mainnetProgram.toBase58()}): ${mainnetHasProgram ? `${mainnetStake} of ${mainnetRows.length} Positions` : "0 (no such program on mainnet)"}`);
  console.log(`   Devnet Positions: ${classified.legacy.length} of 235 bytes (${classified.legacyStake.length} stake), ${classified.current} of 243 bytes`);
  const over = excessClaims(classified.legacyStake);
  console.log(`4. Legacy stake Locks owing holders more than their custody: ${over.length ? over.map((e) => `${e.position.toBase58()} +${e.excess} shares`).join(", ") : "none"}`);
  if (!so) console.log("   No --so: the upgrade is planned against the program's current size");
  else if (deployed) console.log(`   ProgramData already holds this .so (${so.length} bytes): no extend, write-buffer or upgrade`);
  else if (needs.extendBytes) console.log(`   The new .so is ${needs.soBytes} bytes, ProgramData holds ${needs.dataBytes}: extend by ${needs.extendBytes}`);
  console.log(`   Migration: ${migrateTxs(classified.legacy.map((r) => r.pubkey)).length} transactions of up to ${MIGRATIONS_PER_TX} Positions`);

  const refused = gates({ upgrades, genesis: { read: readGenesis, send: sendGenesis, mainnet: mainnetGenesis }, deployer, upgradeAuthority: authority, admin, deployerLamports: balance, required, mainnetStake });
  if (refused.length) {
    console.log(`\nREFUSED (nothing was changed):\n- ${refused.join("\n- ")}`);
    process.exit(1);
  }

  console.log(`\nSteps${send ? "" : " --send would run"}:`);
  let keeperStopped = false;
  let buffer: string | null = null;
  try {
    console.log("3. Stop the keeper");
    // From here a failure reports and repairs the keeper's state, even when the stop itself is what failed.
    keeperStopped = send;
    await stopKeeper();
    console.log("5. Upgrade tesoro_core");
    if (deployed) console.log("  skipped: ProgramData already holds this .so");
    else {
      const key = keypair ? args.need("keypair") : "<deployer keypair>";
      if (needs.extendBytes) run("solana", ["program", "extend", CORE.toBase58(), String(needs.extendBytes), "-u", sendRpc, "-k", key]);
      if (send) {
        const busy = otherUpgrades();
        if (busy.length) throw new Error(`another program upgrade started: ${busy.join(" | ")}`);
      } else console.log("  (checks again that no other upgrade runs)");
      const out = run("solana", ["program", "write-buffer", soPath ?? "<tesoro_core.so>", "-u", sendRpc, "-k", key]);
      buffer = send ? (/Buffer: (\w+)/.exec(out)?.[1] ?? null) : "<buffer>";
      if (!buffer) throw new Error(`write-buffer printed no buffer address: ${out}`);
      run("solana", ["program", "deploy", "--buffer", buffer, "--program-id", CORE.toBase58(), "--upgrade-authority", key, "-u", sendRpc, "-k", key]);
      if (send) {
        let live = false;
        for (let i = 0; i < 20 && !(live = soDeployed((await readProgramData()).data, so!)); i++) await sleep(3_000);
        if (!live) throw new Error(`the upgrade reported success, but ProgramData on ${readRpc} does not hold the .so`);
        buffer = null;
        console.log("  ProgramData holds the new .so");
      }
    }
    console.log("6. migrate_position every 235-byte Position until a scan finds none");
    await sweep(keypair, send ? await positions(reader) : before);
  } catch (e) {
    console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}`);
    if (!keeperStopped) process.exit(1);
    const upgraded = soDeployed((await readProgramData().catch(() => null))?.data ?? Buffer.alloc(0), so!);
    console.error(`KEEPER IS STOPPED (systemd: ${keeperState()})`);
    console.error(`Program upgraded: ${upgraded ? "yes" : "no"}`);
    console.error(`Buffer of this run: ${buffer ?? "none recorded"}. Buffers held by the deployer:`);
    const buffers = spawnSync("solana", ["program", "show", "--buffers", "--buffer-authority", deployer.toBase58(), "-u", readRpc], { encoding: "utf8" });
    console.error((buffers.stdout || buffers.stderr || "").trim().replace(/^/gm, "  "));
    console.error("Close a stranded buffer with `solana program close <buffer> -u <rpc> -k <deployer keypair>` (its rent returns to the deployer).");
    if (upgraded) {
      console.error("The keeper stays stopped: the new program cannot read a 235-byte Position. Re-run the same command; it skips the upgrade and finishes the sweep.");
    } else {
      console.error("The old program is still live, so the keeper starts again:");
      const problem = await startKeeper();
      console.error(problem ? `KEEPER NOT HEALTHY: ${problem}` : "Keeper running and healthy.");
    }
    process.exit(1);
  }
  console.log("7. Start the keeper and check its health");
  const problem = await startKeeper();
  if (problem) {
    console.error(`\nKEEPER NOT HEALTHY after the run: ${problem}. Every Position is migrated; check \`journalctl --user -u tesoro-keeper\` on ${keeperHost}.`);
    process.exit(1);
  }
  console.log("\nThe app copy for RateBelowPeak / YieldCapReached shipped with the step-1 release: nothing to push for it.");
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
