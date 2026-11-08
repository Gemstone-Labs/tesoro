/**
 * Railcar's devnet setup after the program is deployed: registers and lists it in tesoro_core, lets its accounts delegate only
 * to the TEE validator, sets its config, creates and delegates the Sponsor, a Fuel reserve and the Tables, and gives each
 * Table its Vault on the rollup. The steps and their checks are `app/src/games/railcar/setup.ts`.
 *
 * Dry run by default: it reads devnet, prints every step with its signer, accounts, cost and state, and simulates each step
 * still to do (with the steps it needs in front of it, signatures not checked). `--send` sends the steps still to do, in
 * order; each step reads the chain first, so a re-run sends only what is missing.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/railcar-setup.ts [--rpc <url>] [--tee-rpc <url>] [--tables 2] \
 *     [--operator <pubkey>] [--studio <core Account>] [--sponsor-sol 0.1] [--fuel-sol 0.05] [--listed-days 365]
 *   ... --send --keypair <deployer file> --operator-keypair <operator file>
 *
 * Signers: the deployer (Railcar's upgrade authority and tesoro_core's admin on devnet) signs register_game, the TEE-only
 * whitelist, set_config and list_game; the operator signs the Sponsor, Fuel and Table steps and the rollup's init_vault.
 * The operator defaults to the four live Games' operator, the Studio to tesoro_core's `tesoro_studio` Account.
 */
import anchor from "@coral-xyz/anchor";
import { getAuthToken } from "@magicblock-labs/ephemeral-rollups-sdk";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, Transaction, TransactionMessage, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import nacl from "tweetnacl";
import { assertCluster, clusterOf, exitOnUnknownFlag, loadKeypair, parseArgs } from "../src/cli-args.ts";
import { RAILCAR_PROGRAM_ID, tablePda } from "../../app/src/games/railcar/chain.ts";
import { describeIx, railcarSetupPlan, readSetupFacts, setupProblems, withPending, type SetupInput, type SetupStep } from "../../app/src/games/railcar/setup.ts";

const USAGE = "usage: railcar-setup.ts [--send --keypair <deployer file> --operator-keypair <operator file>] [--rpc <url>] [--tee-rpc <url>] [--tables 2] [--operator <pubkey>] [--studio <core Account>] [--sponsor-sol 0.1] [--fuel-sol 0.05] [--listed-days 365]";
const argv = process.argv.slice(2);
exitOnUnknownFlag(argv, { bare: ["send"], valued: ["rpc", "tee-rpc", "keypair", "operator-keypair", "operator", "studio", "tables", "sponsor-sol", "fuel-sol", "listed-days"] }, USAGE);
const a = parseArgs(argv, ["send"]);
const send = a.flag("send");
const cluster = clusterOf("test");
const rpc = a.value("rpc") ?? cluster.solana.defaultRpc!;
const teeRpc = a.value("tee-rpc") ?? cluster.magicblock.teeRpc;
const conn = new Connection(rpc, "confirmed");
await assertCluster(conn, cluster);
const validator = new PublicKey(cluster.magicblock.teeValidator);
const lamportsOf = (flag: string, fallback: string) => BigInt(Math.round(Number(a.value(flag) ?? fallback) * 1e9));
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(4);

const deployer = send ? loadKeypair(a.need("keypair")) : null;
const operatorKey = send ? loadKeypair(a.need("operator-keypair")) : null;

/** The operator the four live Games' tables use (Block Burst's TableConfig): Railcar shares it unless told otherwise. */
async function liveGamesOperator(): Promise<PublicKey> {
  const idl = JSON.parse(readFileSync(new URL("../../app/src/lib/chain/idl/block_puzzle.json", import.meta.url), "utf8"));
  const id = new PublicKey(idl.address);
  const info = await conn.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("config")], id)[0]);
  if (!info) throw new Error("Block Burst has no TableConfig here: pass --operator");
  return (new anchor.BorshAccountsCoder(idl).decode("TableConfig", info.data) as { operator: PublicKey }).operator;
}

const operator = a.value("operator") ? new PublicKey(a.value("operator")!) : operatorKey?.publicKey ?? (await liveGamesOperator());
if (operatorKey && !operatorKey.publicKey.equals(operator)) throw new Error(`--operator-keypair is ${operatorKey.publicKey.toBase58()}, not the operator ${operator.toBase58()}`);

// Who holds the deployer roles on chain now (read before any key is needed).
const programInfo = await conn.getAccountInfo(PublicKey.findProgramAddressSync([RAILCAR_PROGRAM_ID.toBuffer()], new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"))[0]);
const authorityOnChain = programInfo && programInfo.data[12] === 1 ? new PublicKey(programInfo.data.subarray(13, 45)) : PublicKey.default;
const upgradeAuthority = deployer?.publicKey ?? authorityOnChain;

/** A rollup connection with a token: the operator's when sending, a throwaway key's for reading. */
async function rollupConnection(): Promise<Connection | null> {
  const key = operatorKey ?? Keypair.generate();
  try {
    const { token } = await getAuthToken(teeRpc, key.publicKey, async (m: Uint8Array) => nacl.sign.detached(m, key.secretKey));
    return new Connection(`${teeRpc}?token=${token}`, "confirmed");
  } catch (e) {
    console.log(`(the rollup ${teeRpc} gave no token: ${String(e).slice(0, 120)}; Vault states are not read)`);
    return null;
  }
}
const tee = await rollupConnection();

const studioFlag = a.value("studio");
async function inputNow(): Promise<SetupInput> {
  const base = { tables: Number(a.value("tables") ?? 2), fuel: 0, studioAccount: studioFlag ? new PublicKey(studioFlag) : PublicKey.default };
  const facts = await readSetupFacts(conn, tee, base);
  return {
    ...base,
    upgradeAuthority,
    admin: deployer?.publicKey ?? facts.coreConfig?.admin ?? PublicKey.default,
    operator,
    validator,
    studioAccount: studioFlag ? base.studioAccount : facts.tesoroStudio ?? PublicKey.default,
    studioBps: 300,
    sponsorLamports: lamportsOf("sponsor-sol", "0.1"),
    fuelLamports: lamportsOf("fuel-sol", "0.05"),
    listedDays: Number(a.value("listed-days") ?? 365),
    now: Math.floor(Date.now() / 1000),
  };
}

const input = await inputNow();
const plan = async () => {
  const facts = await readSetupFacts(conn, tee, input);
  return { facts, steps: railcarSetupPlan(input, facts) };
};
let { facts, steps } = await plan();
const problems = setupProblems(input, facts);
if (send && deployer && !deployer.publicKey.equals(facts.coreConfig?.admin ?? PublicKey.default)) problems.push(`--keypair is ${deployer.publicKey.toBase58()}, not tesoro_core's admin`);
if (problems.length) {
  for (const p of problems) console.error(`refusing: ${p}`);
  process.exit(1);
}

const keyOf = (s: SetupStep) => (s.signer === "operator" ? operator : s.signer === "admin" ? input.admin : upgradeAuthority);
const signerOf = (s: SetupStep): Keypair => (s.signer === "operator" ? operatorKey! : deployer!);

console.log(`Railcar ${RAILCAR_PROGRAM_ID.toBase58()} on ${rpc} (rollup ${teeRpc})`);
console.log(`upgrade authority ${upgradeAuthority.toBase58()}, core admin ${input.admin.toBase58()}, operator ${operator.toBase58()}, Studio Account ${input.studioAccount.toBase58()}, ${input.tables} Tables\n`);

/** Simulates `chain` (a step with its prerequisites not on chain yet) as one transaction, signatures not checked. */
async function simulate(chain: SetupStep[]): Promise<string> {
  const last = chain[chain.length - 1];
  const rollup = last.layer === "rollup";
  if (rollup && chain.length > 1) return `not simulated: needs ${chain.slice(0, -1).map((s) => s.id).join(", ")} on chain first`;
  const on = rollup ? tee : conn;
  if (!on) return "not simulated: no rollup connection";
  const cu = Math.min(1_400_000, chain.reduce((n, s) => n + s.cu, 0));
  const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...chain.flatMap((s) => s.ixs)];
  const payer = keyOf(chain[0]);
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  let bytes = 0;
  try {
    bytes = tx.serialize().length;
  } catch {
    return `not simulated: ${chain.map((s) => s.id).join(" + ")} do not fit one transaction`;
  }
  if (bytes > 1232) return `not simulated: ${chain.map((s) => s.id).join(" + ")} are ${bytes} B together`;
  const sim = await on.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  const with_ = chain.length > 1 ? ` (with ${chain.slice(0, -1).map((s) => s.id).join(", ")} in front)` : "";
  if (!sim.value.err) return `simulated ok${with_}, ${sim.value.unitsConsumed} CU`;
  const tail = (sim.value.logs ?? []).slice(-6).map((l) => `        ${l}`).join("\n");
  return `SIMULATION FAILED${with_}: ${JSON.stringify(sim.value.err)}\n${tail}`;
}

function print(s: SetupStep, n: number) {
  console.log(`${String(n).padStart(2)}. [${s.status}] ${s.id} (${s.layer}): ${s.title}`);
  console.log(`    signer: ${s.signer} ${keyOf(s).toBase58()}; cost about ${sol(s.lamports)} SOL; now: ${s.note}`);
  console.log(`    why: ${s.why}`);
  for (const ix of s.ixs) {
    const d = describeIx(ix);
    console.log(`    ${d.name}: ${d.accounts.map((x) => `${x.name}${x.signer ? "*" : ""}${x.writable ? "+" : ""}=${x.key.toBase58()}`).join(" ")}`);
  }
}

if (!send) {
  for (const [i, s] of steps.entries()) {
    print(s, i + 1);
    if (s.status === "to do") console.log(`    ${await simulate(withPending(steps, s))}`);
  }
} else {
  const blocked = steps.find((s) => s.status === "blocked");
  if (blocked) throw new Error(`step ${blocked.id} is blocked: ${blocked.note}`);
  for (const [i, s] of steps.entries()) {
    if (s.status !== "to do") continue;
    // Read again: an earlier step (or another run) may have done this one.
    ({ facts, steps } = await plan());
    const now = steps.find((x) => x.id === s.id)!;
    if (now.status !== "to do") continue;
    print(now, i + 1);
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: now.cu }), ...now.ixs];
    const signer = signerOf(now);
    if (now.layer === "base") {
      console.log(`    sent ${await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), [signer], { commitment: "confirmed" })}`);
    } else {
      if (!tee) throw new Error("no rollup connection for the rollup steps");
      // The rollup picks a newly delegated Table up on first use; give it a few tries.
      for (let attempt = 1; ; attempt++) {
        try {
          const tx = new Transaction().add(...ixs);
          tx.feePayer = signer.publicKey;
          tx.recentBlockhash = (await tee.getLatestBlockhash()).blockhash;
          tx.sign(signer);
          const sig = await tee.sendRawTransaction(tx.serialize(), { skipPreflight: false });
          await tee.confirmTransaction(sig, "confirmed");
          console.log(`    sent on the rollup ${sig}`);
          break;
        } catch (e) {
          if (attempt >= 5) throw e;
          console.log(`    rollup try ${attempt} failed (${String(e).slice(0, 120)}); retrying in 5 s`);
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
    }
  }
  ({ facts, steps } = await plan());
}

const left = steps.filter((s) => s.status !== "done");
const bySigner = new Map<string, bigint>();
for (const s of left) bySigner.set(`${s.signer} ${keyOf(s).toBase58()}`, (bySigner.get(`${s.signer} ${keyOf(s).toBase58()}`) ?? 0n) + s.lamports);
console.log(`\n${steps.length - left.length} of ${steps.length} steps done; ${left.length} left${left.length ? ` (${left.map((s) => s.id).join(", ")})` : ""}`);
for (const [who, l] of bySigner) console.log(`  ${who} spends about ${sol(l)} SOL`);
console.log(`  Tables: ${facts.tables.map((t) => `${t.index} ${tablePda(t.index).toBase58()} ${t.base}${t.vaultReady ? " + Vault" : ""}`).join("; ")}`);
if (send && left.length) process.exit(1);
