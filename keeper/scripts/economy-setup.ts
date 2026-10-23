/**
 * Ticket 24 setup calls for the economy upgrade on devnet, run after the programs are upgraded. Admin and upgrade authority
 * are the deployer key. One step per run, `--dry-run` simulates instead of sending.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/economy-setup.ts <step> --keypair <deployer file> [--rpc <url>] [--dry-run] [options]
 *
 * Steps:
 *   economy    set_economy (Season keeper, fill keeper, routes), set_tesoro_studio (--company-keypair; creates that Account first)
 *   sponsor    init_sponsor (--relayer <pubkey>), set_accounts_cap, set_profiles_cap, then funds the Sponsor PDA (--fund-sol)
 *   stores     init_stores for the system Accounts that predate baskets (platform recipient, Pool, Treasury)
 *   tables     set_config / set_table_config of the four Games (TableConfig: operator = --operator, generation, max tables)
 *   retire-offers  closes every OfferState that is not the current 174-byte layout (retire_offer takes any other length)
 *   status     prints what exists
 */
import anchor from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from "@solana/web3.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadKeypair, parseArgs } from "../src/cli-args.ts";
import { configPda, coreAccountPda, coreIx, programDataPda } from "../src/launch-admin.ts";
import { TESORO_CORE_ID, nativeCustodyPda } from "../../app/src/lib/chain/native.ts";

const a = parseArgs(process.argv.slice(2), ["dry-run"]);
const [step] = a.positional;
const rpc = a.value("rpc") ?? "https://rpc.magicblock.app/devnet";
const conn = new Connection(rpc, "confirmed");
const dry = a.flag("dry-run");
const core = TESORO_CORE_ID;
const pk = (n: string) => new PublicKey(a.need(n));
const lam = (sol: string) => BigInt(Math.round(Number(sol) * 1e9));
const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, core)[0];
const idlOf = (g: string) => JSON.parse(readFileSync(new URL(`../../app/src/lib/chain/idl/${g}.json`, import.meta.url), "utf8"));

const deployer = loadKeypair(a.need("keypair"));
if (deployer.publicKey.toBase58() !== "7zr1j185zT8r6jcysC4LyrdSEJ13Up3xq4TFu6KQqh7M") throw new Error("expected the deployer key");

async function send(label: string, ixs: TransactionInstruction[], signers: Keypair[] = [deployer]) {
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs);
  if (dry) {
    tx.feePayer = deployer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    tx.partialSign(...signers);
    const sim = await conn.simulateTransaction(tx);
    console.log(`${label} (dry run):`, sim.value.err ? `WOULD FAIL ${JSON.stringify(sim.value.err)}` : `ok, ${sim.value.unitsConsumed} CU`);
    if (sim.value.err) for (const l of sim.value.logs ?? []) console.log("   ", l);
    return;
  }
  console.log(label, await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed" }));
}

const exists = async (k: PublicKey) => (await conn.getAccountInfo(k)) !== null;

async function createAccountFor(authority: Keypair) {
  const account = coreAccountPda(core, authority.publicKey);
  if (await exists(account)) return console.log("Account exists", account.toBase58());
  const ix = coreIx(core, "create_account", { authority: authority.publicKey, payer: authority.publicKey }, { evm_address: Array(20).fill(0) });
  await send(`create_account ${authority.publicKey.toBase58()}`, [SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: authority.publicKey, lamports: 100_000_000n }), ix], [deployer, authority]);
}

if (step === "economy") {
  const company = loadKeypair(a.need("company-keypair"));
  const keeper = pk("keeper");
  await createAccountFor(company);
  await send(
    "set_economy",
    [coreIx(core, "set_economy", { admin: deployer.publicKey, config: configPda(core) }, { season_keeper: keeper, fill_keeper: keeper, keeper_fills: false, routes: [nativeCustodyPda(), PublicKey.default, PublicKey.default, PublicKey.default] })],
  );
  await send("set_tesoro_studio", [coreIx(core, "set_tesoro_studio", { admin: deployer.publicKey, config: configPda(core), recipient_account: coreAccountPda(core, company.publicKey) })]);
} else if (step === "sponsor") {
  const sponsor = pda([Buffer.from("sponsor")]);
  const BN = anchor.BN;
  if (!(await exists(sponsor))) {
    await send("init_sponsor", [
      coreIx(core, "init_sponsor", { admin: deployer.publicKey, config: configPda(core) }, { relayer: pk("relayer"), per_account_cap: new BN(a.value("per-account") ?? 200_000_000), total_cap: new BN(a.value("total") ?? 20_000_000_000), pages_cap: new BN(a.value("pages") ?? 2_000_000_000) }),
    ]);
  } else console.log("Sponsor exists");
  await send("set_accounts_cap", [coreIx(core, "set_accounts_cap", { admin: deployer.publicKey, config: configPda(core), sponsor }, { accounts_cap: new BN(a.value("accounts-cap") ?? 3_000_000_000) })]);
  await send("set_profiles_cap", [coreIx(core, "set_profiles_cap", { admin: deployer.publicKey, config: configPda(core), sponsor }, { profiles_cap: new BN(a.value("profiles-cap") ?? 1_000_000_000) })]);
  if (a.value("fund-sol")) await send(`fund Sponsor ${sponsor.toBase58()}`, [SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: sponsor, lamports: lam(a.value("fund-sol")!) })]);
} else if (step === "stores") {
  for (const authority of a.values("authority").map((x) => new PublicKey(x))) {
    const account = coreAccountPda(core, authority);
    const ix = coreIx(core, "init_stores", { payer: deployer.publicKey, account });
    await send(`init_stores ${authority.toBase58()}`, [ix]).catch((e) => console.log("  skipped:", String(e).slice(0, 160)));
  }
} else if (step === "tables") {
  const operator = pk("operator");
  const generation = Number(a.value("generation") ?? 1);
  const max = Number(a.value("max-tables") ?? 64);
  for (const g of ["block_puzzle", "holdem", "trading_duel", "vanguard"]) {
    const idl = idlOf(g);
    const id = new PublicKey(idl.address);
    const program = new anchor.Program(idl, new anchor.AnchorProvider(conn, new anchor.Wallet(deployer), {}));
    const m: any = program.methods;
    const accts = { authority: deployer.publicKey, program: id, programData: programDataPda(id) };
    const ix = await (g === "vanguard" ? m.setTableConfig(operator, generation, max) : m.setConfig(operator, generation, max)).accountsPartial(accts).instruction();
    await send(`${g} ${g === "vanguard" ? "set_table_config" : "set_config"} operator ${operator.toBase58()} generation ${generation} max ${max}`, [ix]);
  }
} else if (step === "retire-offers") {
  const reader = new Connection(a.value("read-rpc") ?? "https://api.devnet.solana.com", "confirmed");
  const all = await reader.getProgramAccounts(core);
  const offers = all.filter((x) => x.account.data.length >= 8 && x.account.data.length !== 174 && Buffer.from(x.account.data.subarray(0, 8)).equals(Buffer.from(createHash("sha256").update("account:OfferState").digest().subarray(0, 8))));
  console.log(`${offers.length} old Offers`);
  for (const o of offers) await send(`retire_offer ${o.pubkey.toBase58()} (${o.account.data.length} B)`, [coreIx(core, "retire_offer", { admin: deployer.publicKey, config: configPda(core), offer: o.pubkey })]);
} else if (step === "status") {
  for (const [n, k] of Object.entries({ config: configPda(core), economy: pda([Buffer.from("economy")]), sponsor: pda([Buffer.from("sponsor")]), nativeCustody: nativeCustodyPda(), treasury: pda([Buffer.from("treasury")]) })) {
    const i = await conn.getAccountInfo(k);
    console.log(n.padEnd(14), k.toBase58(), i ? `${i.data.length} B, ${i.lamports / 1e9} SOL` : "none");
  }
} else throw new Error("step: economy | sponsor | stores | tables | status");
