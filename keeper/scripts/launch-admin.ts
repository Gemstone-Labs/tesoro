/**
 * Prints (never sends, unless --execute) every tesoro_core launch init call in runbook order (ticket 44,
 * docs/mainnet-runbook.md "T-7 days", step 5): the Squads vault's own Account, initialize_config, the Treasury, the staking
 * token and APY ceiling, the three Pyth price mappings, entry sizes, the Games, the Leaderboard, the Treasury company, the
 * Source authorities, the TEE whitelist reminder and, last, the Invite gate. Each step prints its signer, every account by
 * name, the Borsh data in base64, and what to check afterwards. A step signed by the Squads vault is a proposal: submit the
 * printed instruction in Squads. `--execute` sends only the steps the single `--keypair` signs.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/launch-admin.ts \
 *     --cluster mainnet --admin <DEPLOYER pubkey|keypair file> --vault <SQUADS_VAULT_PDA> \
 *     --oracle <ORACLE_PUBKEY> --platform-bps 200 \
 *     --game block_puzzle=<STUDIO_WALLET>[,300] --game holdem=<STUDIO_WALLET> --game trading_duel=<STUDIO_WALLET> \
 *     --company <COMPANY_WALLET> --invite <INVITE_PUBKEY> \
 *     [--program tesoro_core=<ID> ...] [--steps config,treasury,...] [--rpc <URL>] \
 *     [--yield-fee-bps 2000] [--instant-fee-bps 2500] [--apy-ceiling-bps 800] [--entry-sizes 100,500,1000] \
 *     [--leaderboard-bps 100] [--max-age-secs 90] [--max-conf-bps 100] [--vault-evm 0x...] \
 *     [--execute --keypair <ADMIN KEYPAIR FILE>]
 *
 * Steps (default: all, in this order): vault-account, config, treasury, stake-token, apy-ceiling, prices, entry-sizes,
 * games, leaderboard, company, sources, whitelist, invite-gate. `--list-steps` prints them. With `--rpc` even a dry run
 * checks the RPC serves the cluster (genesis hash).
 */
import { Connection, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { assertCluster, clusterOf, loadKeypair, parseArgs, programOverrides, resolveKey } from "../src/cli-args.ts";
import { PROGRAMS } from "../src/mainnet-keys.ts";
import { STEP_NAMES, buildLaunchPlan, describeStep, type GameInput, type StepName } from "../src/launch-admin.ts";

const a = parseArgs(process.argv.slice(2), ["execute", "list-steps"]);
if (a.flag("list-steps")) {
  console.log(STEP_NAMES.join("\n"));
  process.exit(0);
}

const cluster = clusterOf(a.value("cluster"));
const key = (n: string) => (a.value(n) ? resolveKey(a.value(n)!) : undefined);
const num = (n: string) => (a.value(n) !== undefined ? Number(a.value(n)) : undefined);
const steps = a.value("steps")?.split(",").map((s) => {
  if (!(STEP_NAMES as readonly string[]).includes(s)) throw new Error(`--steps: unknown step ${s}; expected ${STEP_NAMES.join(", ")}`);
  return s as StepName;
});
const games: GameInput[] = a.values("game").map((g) => {
  const [name, rest] = g.split("=");
  const [studio, bps, control, slot, until] = (rest ?? "").split(",");
  if (!(["block_puzzle", "holdem", "trading_duel"] as string[]).includes(name) || !studio) throw new Error(`--game ${g}: expected <block_puzzle|holdem|trading_duel>=<studio wallet>[,<studio bps>[,<upgrade authority>[,<approved slot>,<listed until unix>]]]`);
  return {
    name: name as GameInput["name"],
    studio: new PublicKey(studio),
    studioBps: bps ? Number(bps) : 300,
    control: control ? new PublicKey(control) : undefined,
    approvedSlot: slot ? Number(slot) : undefined,
    listedUntil: until ? Number(until) : undefined,
  };
});

const admin = resolveKey(a.need("admin"));
const plan = buildLaunchPlan({
  admin,
  vault: new PublicKey(a.need("vault")),
  programs: programOverrides(a.values("program")),
  oracle: key("oracle"),
  platformBps: num("platform-bps"),
  yieldFeeBps: num("yield-fee-bps"),
  instantFeeBps: num("instant-fee-bps"),
  apyCeilingBps: num("apy-ceiling-bps"),
  entrySizes: a.value("entry-sizes")?.split(",").map(Number),
  maxAgeSecs: num("max-age-secs"),
  maxConfBps: num("max-conf-bps"),
  leaderboardBps: num("leaderboard-bps"),
  games,
  company: key("company"),
  invite: key("invite"),
  vaultEvm: a.value("vault-evm"),
  steps,
});

const execute = a.flag("execute");
console.log(execute ? "MODE: EXECUTE (sends only the steps the --keypair signs)" : "MODE: DRY RUN (nothing is sent; add --execute to send single-key steps)");
console.log(`cluster ${cluster.solana.label}   core ${new PublicKey(programOverrides(a.values("program")).tesoro_core ?? PROGRAMS.tesoro_core).toBase58()}   admin ${admin.toBase58()}   vault ${a.need("vault")}\n`);
for (const s of plan) console.log(describeStep(s) + "\n");

const rpc = a.value("rpc");
if (rpc) {
  const conn = new Connection(rpc, "confirmed");
  await assertCluster(conn, cluster);
  console.log(`RPC serves ${cluster.solana.label}.`);
}
if (!execute) {
  console.log("Dry run only. Read every account against docs/mainnet-runbook.md (section 5) before sending anything.");
  process.exit(0);
}

if (!rpc) throw new Error("--execute needs --rpc");
const signer = loadKeypair(a.need("keypair"));
if (!signer.publicKey.equals(admin)) throw new Error(`--keypair is ${signer.publicKey.toBase58()}, not --admin ${admin.toBase58()}`);
const conn = new Connection(rpc, "confirmed");
for (const s of plan) {
  if (!s.signer || s.proposal || !s.ixs.length) continue;
  if (!s.signer.equals(signer.publicKey)) {
    console.log(`[${s.id}] skipped ${s.title}: signed by ${s.signer.toBase58()}, not by this keypair`);
    continue;
  }
  const tx = new Transaction().add(...s.ixs);
  tx.feePayer = signer.publicKey;
  console.log(`[${s.id}] sending ${s.title}`);
  console.log(`[${s.id}] ->`, await sendAndConfirmTransaction(conn, tx, [signer]));
}
