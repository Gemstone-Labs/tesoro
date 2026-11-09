/**
 * A Railcar ride end to end in LiteSVM, driven by the app's own builders and the shared many-seat planner: five Players
 * board through the Queue choice, the car departs, the ride runs (Jumps, a signal at Impact), Railcar's `finalize` sends
 * core the result, every settle chunk the planner sizes runs, and every seat and the car close. The worked example must
 * pay to the Gema: Dee 813, Ben 630, Cy 578, Ana 350, Eve 0, Studio Fee 64.
 *
 * Needs the built programs (`pnpm build:programs --throwaway-keys`): `target/deploy/{tesoro_core,railcar}.so`, or the
 * directory in RAILCAR_SO_DIR. Skipped when they are missing.
 *
 * Stand-ins, as the Rust ride tests (programs/railcar/tests/ride.rs) use them: one LiteSVM is both base and rollup; the
 * magic, permission and VRF programs accept anything (`test-programs/noop.so`); the Vault is written as `init_vault`
 * would; the VRF callback is signed by its scoped identity directly; a commit is base keeping the Table's bytes, and
 * `finalize` reads them owned by the delegation program.
 *
 * Every transaction is compiled by the app's one size rule (`lib/chain/tx-size`) with no lookup table, as the sponsor
 * sends it when `TESORO_SPONSOR_LOOKUP_TABLES` is unset: one over 1,232 B or 64 accounts fails the test, naming its
 * instructions. Boarding goes as the sponsor sends it: the relayer pays, the wallet and the seat key sign.
 */
import { AnchorProvider, BN, BorshAccountsCoder, Program, type Idl } from "@coral-xyz/anchor";
import { DELEGATION_PROGRAM_ID, PERMISSION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  VersionedMessage,
  VersionedTransaction,
  type AccountInfo,
  type AccountMeta,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLASS_STUDIO, basketPda, bookPda, ckptPda, countersPda, matchPda, spillPda } from "../../lib/chain/basket";
import { coreIx } from "../../lib/chain/core-ix";
import { drawRemaining, freshPot, nextMatchOf, previewEntry, readEntryStores, readNextTicket } from "../../lib/chain/entry";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import railcarIdl from "../../lib/chain/idl/railcar.json";
import { acceptOfferIx, backingNonce, createOfferIx, createRequestIx } from "../../lib/chain/backing-ix";
import { decodeCar, joinSeatIx, seatMarkPda } from "../../lib/chain/many-seat";
import { loadCar } from "../../lib/chain/many-seat-plan";
import { decodeStore } from "../../lib/chain/pot-store";
import { OVERFLOW_STORE_AT, matchOverflowPda } from "../../lib/chain/overflow";
import { CHUNK_CU_TARGET, fits, initCkptPageIx, type Reader } from "../../lib/chain/settle-plan";
import { checkedV0, instructionName, messageSize, type TxSize } from "../../lib/chain/tx-size";
import { backingTicketOf, nextStageIx, openBackingTicketIxs, type TicketView } from "../../lib/chain/ticket";
import { Sponsor, sponsoredInstructions, type ChainReads } from "../../server/sponsor/service";
import { DEFAULT_LIMITS } from "../../server/sponsor/policy";
import { MemoryUsageStore } from "../../server/sponsor/store";
import { assertSeatMay } from "../../lib/seat/seat-scope";
import { rideSweepStep, type SweepEnv } from "./sweep";
import bs58 from "bs58";
import {
  RAILCAR_PROGRAM_ID,
  bindBrakeIx,
  brakeSeatPda,
  checkDepartureIx,
  decodeBrakeSeat,
  tickIx,
  configPda,
  decodeCarAccount,
  decodeConfig,
  decodeTable,
  jumpIx,
  openCarIx,
  railcarIx,
  signalIx,
  startRideIx,
  tablePda,
  vaultPda,
  carPda,
} from "./chain";
import { BIND_PER_SEND } from "./brake";
import { brakeRoute } from "./signers";
import { impactMs, ride } from "./engine";
import { replayRide, type RideReplay } from "./replay";
import { rideRecordOf } from "../../lib/chain/ride-history";
import { decodeMatchRecords, type InnerInstruction } from "../../server/history/events";
import { ingestMatchRecords } from "../../server/history/ingest";
import { accountHistory, matchPage } from "../../server/history/reads";
import { testDb } from "../../server/history/test-db";
import { queueChoice } from "./flow";
import { railcarView } from "./view";
import { finishRide } from "./finish";
import { backerSeatedIn, boardingEntry, type BoardingBacking } from "./boarding";
import { stepOffFor } from "./step-off";
import { fuelPda, programConfigPda, railcarSetupPlan, readSetupFacts, setupProblems, type AccountReader, type SetupInput, type SetupStep } from "./setup";
import { MAGICBLOCK } from "../../lib/cluster-settings";
import { POOL, SIM_LST_ID, SIM_SOL_MINT, TOKEN_PROGRAM_ID, faucetIx, nativeCustodyPda, nativeVaultPda, openNativePositionIx, setPriceIx, takeNativeAdvanceIx } from "../../lib/chain/native";

const ROOT = join(process.cwd(), "..");
const SO_DIR = process.env.RAILCAR_SO_DIR ?? join(ROOT, "target/deploy");
const BUILT = existsSync(join(SO_DIR, "tesoro_core.so")) && existsSync(join(SO_DIR, "railcar.so"));

const CORE = new PublicKey((coreIdl as { address: string }).address);
const UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const MAGIC = new PublicKey("Magic11111111111111111111111111111111111111");
const VRF = new PublicKey("Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz");
const SOL = 1_000_000_000n;
const T0 = 1_000_000;
const SLOT0 = 5_000_000n;
const SPS = 100n;

const corePda = (...seeds: (string | Buffer)[]) => PublicKey.findProgramAddressSync(seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)), CORE)[0];
const accountOf = (wallet: PublicKey) => corePda("account", wallet.toBuffer());
const programData = (program: PublicKey) => PublicKey.findProgramAddressSync([program.toBuffer()], UPGRADEABLE)[0];
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const cu = (units: number) => ComputeBudgetProgram.setComputeUnitLimit({ units });

interface Person {
  kp: Keypair;
  key: PublicKey;
  account: PublicKey;
  /** The seat key the wallet names when it boards (seat keys D5): it co-signs the join and plays the Jumps. */
  seat: Keypair;
}

// The worked example's riders, by seat.
const [ANA, BEN, CY, DEE] = [0, 1, 2, 3];

type Acct = { lamports: number; data: Uint8Array; owner: PublicKey; executable: boolean };
type Lite = typeof import("litesvm");
interface Inner {
  addProgramWithLoader(id: Uint8Array, bytes: Uint8Array, loader: Uint8Array): void;
  addProgram(id: Uint8Array, bytes: Uint8Array): void;
  airdrop(k: Uint8Array, lamports: bigint): unknown;
  expireBlockhash(): void;
  latestBlockhash(): string;
  setClock(c: unknown): void;
  getAccount(k: Uint8Array): { lamports(): bigint; data(): Uint8Array; owner(): Uint8Array; executable(): boolean } | null;
  setAccount(k: Uint8Array, a: unknown): void;
  simulateVersionedTransaction(bytes: Uint8Array): { meta(): { computeUnitsConsumed(): bigint }; err?(): unknown; postAccounts?(): { address: Uint8Array; account(): { lamports(): bigint } }[] };
  sendVersionedTransaction(bytes: Uint8Array): { logs?(): string[]; meta?(): { logs(): string[] }; err?(): unknown; innerInstructions?(): { instruction(): { programIdIndex(): number; accounts(): Uint8Array; data(): Uint8Array } }[][]; computeUnitsConsumed?(): bigint };
}

/**
 * LiteSVM driven through its native object with web3.js bytes (litesvm 1.x speaks @solana/kit; the app's builders make
 * web3.js instructions). Every account read is copied while the native object is held.
 */
class Svm {
  constructor(
    private lib: Lite,
    private inner: Inner,
  ) {}
  static async create(): Promise<Svm> {
    const lib = await import("litesvm");
    return new Svm(lib, (new lib.LiteSVM().withSigverify(false) as unknown as { inner: Inner }).inner);
  }
  addUpgradeable(id: PublicKey, bytes: Uint8Array) {
    this.inner.addProgramWithLoader(id.toBytes(), bytes, UPGRADEABLE.toBytes());
  }
  addProgram(id: PublicKey, bytes: Uint8Array) {
    this.inner.addProgram(id.toBytes(), bytes);
  }
  airdrop(k: PublicKey, lamports: bigint) {
    this.inner.airdrop(k.toBytes(), lamports);
  }
  expireBlockhash() {
    this.inner.expireBlockhash();
  }
  latestBlockhash() {
    return this.inner.latestBlockhash();
  }
  setClock(slot: bigint, ts: number) {
    this.inner.setClock(new this.lib.Clock(slot, 0n, 0n, 0n, BigInt(ts)));
  }
  get(k: PublicKey): Acct | null {
    const a = this.inner.getAccount(k.toBytes());
    if (!a) return null;
    return { lamports: Number(a.lamports()), data: Uint8Array.from(a.data()), owner: new PublicKey(Uint8Array.from(a.owner())), executable: a.executable() };
  }
  set(k: PublicKey, a: Acct) {
    this.inner.setAccount(k.toBytes(), new this.lib.Account(BigInt(a.lamports), a.data, a.owner.toBytes(), a.executable, 0n));
  }
  /** Compute units of a dry run, or null when it fails (as the app's `unitsOf` reads a simulation). */
  simulate(tx: VersionedTransaction): number | null {
    const r = this.inner.simulateVersionedTransaction(tx.serialize());
    return r.err ? null : Number(r.meta().computeUnitsConsumed());
  }
  /** A dry run as the sponsor's chain reports it: whether it failed, and what `watch` holds after it. */
  simulateWatch(tx: VersionedTransaction, watch: PublicKey): { err: unknown; lamports: bigint | null } {
    const r = this.inner.simulateVersionedTransaction(tx.serialize());
    if (r.err) return { err: r.err(), lamports: null };
    const post = r.postAccounts!().find((a) => new PublicKey(a.address).equals(watch));
    return { err: null, lamports: post ? post.account().lamports() : BigInt(this.get(watch)?.lamports ?? 0) };
  }
  /** `keys` resolves the message's account indexes (lookup tables included) for the inner instructions. */
  send(tx: VersionedTransaction, keys: (i: number) => PublicKey): { logs: string[]; err: unknown; inner: InnerInstruction[]; units: number } {
    const r = this.inner.sendVersionedTransaction(tx.serialize());
    const logs = r.meta ? r.meta().logs() : r.logs!();
    const inner = (r.innerInstructions?.() ?? []).flat().map((x) => {
      const c = x.instruction();
      return { programId: keys(c.programIdIndex()).toBase58(), accounts: Array.from(c.accounts(), (a) => keys(a).toBase58()), data: Uint8Array.from(c.data()) };
    });
    return { logs, err: r.err ? r.err() : null, inner, units: Number(r.computeUnitsConsumed?.() ?? 0n) };
  }
}

/** The LiteSVM world: tesoro_core and Railcar as the Rust ride tests set them up, plus who signed what. */
class World {
  // Imported lazily so the suite only needs the native module where the programs are built.
  svm!: Svm;
  admin = Keypair.generate();
  oracle = Keypair.generate();
  ctl = Keypair.generate();
  operator = Keypair.generate();
  /** Pays and calls every step a Player's page has the relayer send (sponsored): never a Player's wallet. */
  relayer = Keypair.generate();
  /** The page key that signs the rollup's anyone-may steps (signals, start). */
  pageKey = Keypair.generate();
  studio!: Person;
  committed = new Map<string, Uint8Array>();
  stakes = 0;
  slot = SLOT0;
  now = T0;
  /** Every transaction a rider's wallet signed, by the phase it was in. */
  walletSigs: Record<string, number> = {};
  phase = "setup";
  riders: Person[] = [];
  lastLogs: string[] = [];
  lastInner: InnerInstruction[] = [];
  lastUnits = 0;

  /** With `setup: "script"` Railcar is set up by the devnet setup script's plan instead of by hand (`setUpByScript`). */
  static async create(o: { setup?: "script" } = {}): Promise<World> {
    const w = new World();
    // On devnet one deployer key is both Railcar's upgrade authority and tesoro_core's admin.
    if (o.setup === "script") w.ctl = w.admin;
    w.svm = await Svm.create();
    w.svm.addUpgradeable(CORE, readFileSync(join(SO_DIR, "tesoro_core.so")));
    w.svm.addUpgradeable(RAILCAR_PROGRAM_ID, readFileSync(join(SO_DIR, "railcar.so")));
    const noop = readFileSync(join(__dirname, "test-programs/noop.so"));
    for (const id of [MAGIC, PERMISSION_PROGRAM_ID, VRF]) w.svm.addProgram(id, noop);
    if (o.setup === "script") w.svm.addProgram(DELEGATION_PROGRAM_ID, noop);
    for (const k of [w.admin, w.oracle, w.ctl, w.operator, w.relayer, w.pageKey]) w.svm.airdrop(k.publicKey, 1_000n * SOL);
    w.setTime(T0);
    await w.setUp(o.setup);
    return w;
  }

  // ---- sending ------------------------------------------------------------------------------------------------------

  /** The largest size each kind of transaction took (its instructions, compute budget left out). */
  sizes = new Map<string, TxSize>();

  send(ixs: TransactionInstruction[], payer: Keypair, signers: Keypair[] = [], tables: AddressLookupTableAccount[] = []): void {
    this.svm.expireBlockhash();
    const msg = checkedV0(payer.publicKey, this.svm.latestBlockhash(), ixs, tables);
    const kind = ixs.map(instructionName).filter((n) => n !== "compute_budget").join(" + ");
    const size = messageSize(msg);
    if (size.bytes > (this.sizes.get(kind)?.bytes ?? 0)) this.sizes.set(kind, size);
    const tx = new VersionedTransaction(msg);
    const all = [payer, ...signers];
    tx.sign(all.filter((k, i) => all.findIndex((x) => x.publicKey.equals(k.publicKey)) === i && msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).some((s) => s.equals(k.publicKey))));
    for (const r of this.riders) if (msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).some((s) => s.equals(r.key))) this.walletSigs[this.phase] = (this.walletSigs[this.phase] ?? 0) + 1;
    const keys = msg.getAccountKeys({ addressLookupTableAccounts: tables });
    const res = this.svm.send(tx, (i) => keys.get(i)!);
    this.lastLogs = res.logs;
    this.lastInner = res.inner;
    this.lastUnits = res.units;
    if (res.err) throw new Error(`transaction failed: ${String(res.err)}\n${this.lastLogs.join("\n")}`);
  }

  /** Sends a transaction signed elsewhere (the sponsor's), as the sponsor's chain does; returns its signature. */
  sendRaw(raw: Uint8Array): string {
    const tx = VersionedTransaction.deserialize(raw);
    const keys = tx.message.getAccountKeys();
    const res = this.svm.send(tx, (i) => keys.get(i)!);
    this.lastLogs = res.logs;
    this.lastInner = res.inner;
    this.lastUnits = res.units;
    if (res.err) throw new Error(`transaction failed: ${String(res.err)}\n${this.lastLogs.join("\n")}`);
    return bs58.encode(tx.signatures[0]);
  }

  /** The compute `ixs` would use, simulated with `payer` as fee payer and no signature (as the page simulates a chunk). */
  simulate(ixs: TransactionInstruction[], payer: PublicKey): number | null {
    this.svm.expireBlockhash();
    return this.svm.simulate(new VersionedTransaction(checkedV0(payer, this.svm.latestBlockhash(), ixs)));
  }

  setClock(slot: bigint, ts: number) {
    this.slot = slot;
    this.now = ts;
    this.svm.setClock(slot, ts);
  }
  setTime(t: number) {
    this.setClock(SLOT0 + BigInt(Math.max(0, t - T0)) * SPS, t);
  }
  setSlot(slot: bigint) {
    this.setClock(slot, T0 + Number((slot - SLOT0) / SPS));
  }

  get(k: PublicKey): Acct | null {
    return this.svm.get(k);
  }

  info(k: PublicKey): AccountInfo<Buffer> | null {
    const a = this.get(k);
    return a && a.lamports > 0 ? { data: Buffer.from(a.data), owner: a.owner, lamports: a.lamports, executable: a.executable, rentEpoch: 0 } : null;
  }
  reader(): Reader & { getMultipleAccountsInfo(keys: PublicKey[]): Promise<(AccountInfo<Buffer> | null)[]> } {
    return { many: async (keys) => keys.map((k) => this.info(k)), getMultipleAccountsInfo: async (keys) => keys.map((k) => this.info(k)) };
  }

  // ---- setup (as programs/railcar/tests/ride.rs `Env::new`) ------------------------------------------------------------

  async setUp(by?: "script") {
    const admin = this.admin;
    const platform = this.person();
    this.studio = this.person();
    this.send([coreIx("initialize_config", { admin: admin.publicKey, config: corePda("config"), platform_recipient: platform.account }, { oracle_authority: this.oracle.publicKey, platform_bps: 200 })], admin);
    this.send([coreIx("set_economy", { admin: admin.publicKey, config: corePda("config"), economy: corePda("economy") }, { season_keeper: PublicKey.default, fill_keeper: PublicKey.default, keeper_fills: false, routes: [PublicKey.default, PublicKey.default, PublicKey.default, PublicKey.default] })], admin);
    const coder = new BorshAccountsCoder(coreIdl as unknown as Idl);
    const [treasury, bump] = PublicKey.findProgramAddressSync([Buffer.from("treasury")], CORE);
    const tdata = await coder.encode("Treasury", { bump, vault_bump: 0, account_bump: 0, yield_fee_bps: 0, instant_fee_bps: 3_500, account: PublicKey.default, vault: PublicKey.default, retired_fee_minted: new BN(0), instant_units: new BN(0), funded_shares: new BN(0), withdrawn_units: new BN(0), company: PublicKey.default });
    this.svm.set(treasury, { lamports: Number(SOL), data: tdata, owner: CORE, executable: false });
    const pool = corePda("leaderboard");
    this.send([coreIx("init_leaderboard", { admin: admin.publicKey, config: corePda("config"), pool_authority: pool, pool_account: corePda("account", pool.toBuffer()), treasury }, { leaderboard_bps: 100 })], admin);
    // core's sponsor, which fronts the rent of the sponsored Tickets the relayer opens
    this.send([coreIx("init_sponsor", { admin: admin.publicKey, config: corePda("config"), sponsor: corePda("sponsor") }, { relayer: this.relayer.publicKey, per_account_cap: 100n * SOL, total_cap: 1_000n * SOL, pages_cap: 100n * SOL })], admin);
    this.svm.airdrop(corePda("sponsor"), 100n * SOL);
    // The control key is Railcar's upgrade authority; core approves the build's hash.
    const pd = programData(RAILCAR_PROGRAM_ID);
    const acct = this.get(pd)!;
    const data = Buffer.from(acct.data);
    data[12] = 1;
    this.ctl.publicKey.toBuffer().copy(data, 13);
    let end = data.length;
    while (end > 45 && data[end - 1] === 0) end--;
    const hash = createHash("sha256").update(data.subarray(45, end)).digest();
    this.svm.set(pd, { ...acct, data });
    if (by === "script") return this.setUpByScript();
    const gameRecord = corePda("game", RAILCAR_PROGRAM_ID.toBuffer());
    const authority = PublicKey.findProgramAddressSync([Buffer.from("authority")], RAILCAR_PROGRAM_ID)[0];
    this.send(
      [coreIx("register_game", { payer: admin.publicKey, control: this.ctl.publicKey, config: corePda("config"), game_program: RAILCAR_PROGRAM_ID, program_data: pd, studio_recipient: this.studio.account, game_record: gameRecord }, { settle_authority: authority, studio_bps: 300 })],
      admin,
      [this.ctl],
    );
    this.send([cu(1_400_000), coreIx("list_game", { admin: admin.publicKey, config: corePda("config"), game_record: gameRecord, game_program: RAILCAR_PROGRAM_ID, program_data: pd }, { listed_until: 4_000_000_000n, approved_hash: Array.from(hash) })], admin);
    this.ensureSpill(this.studio, 64);

    this.send([railcarIx("set_config", { authority: this.ctl.publicKey, config: configPda(), program_data: pd }, { operator: this.operator.publicKey, tables: 2 })], this.ctl);
    this.send([railcarIx("create_sponsor", { operator: this.operator.publicKey, config: configPda(), sponsor: PublicKey.findProgramAddressSync([Buffer.from("sponsor")], RAILCAR_PROGRAM_ID)[0] }, { lamports: SOL })], this.operator);
    for (const index of [0, 1]) {
      const table = tablePda(index);
      this.send([railcarIx("create_table", { operator: this.operator.publicKey, config: configPda(), table }, { index })], this.operator);
      // `init_vault` stand-in: the Vault exists, blank, and the Table says so.
      this.svm.set(vaultPda(table), { lamports: Number(SOL), data: await blankVault(table), owner: RAILCAR_PROGRAM_ID, executable: false });
      const t = this.get(table)!;
      const td = Buffer.from(t.data);
      td[8 + 15] = 1;
      this.svm.set(table, { ...t, data: td });
      this.committed.set(table.toBase58(), td);
    }
  }

  /** Accounts handed to the delegation program, by address: base sees them owned by it, holding their last commit. */
  delegated = new Set<string>();
  /** Every setup step the script's plan listed, with its status when it was sent. */
  setupRun: { first: SetupStep[]; again: SetupStep[] } | null = null;

  /**
   * Railcar set up as `keeper/scripts/railcar-setup.ts --send` sets it up on devnet: the plan read from this chain, each step
   * still to do sent with its own instructions and signer, then the plan read again. MagicBlock's programs are stand-ins
   * (they accept anything), so after each of their steps the account is put where the real program leaves it:
   * - the TEE whitelist: the `p-conf` account naming the TEE validator;
   * - a delegation: base holds the account owned by the delegation program with its bytes as delegated, the rollup the
   *   account as it was (Railcar's);
   * - `init_vault`: the magic program's ephemeral account (an empty Railcar account of the Vault's size) exists before the
   *   instruction runs, so Railcar's own code writes the Vault and marks the Table.
   */
  async setUpByScript() {
    const input: SetupInput = {
      upgradeAuthority: this.admin.publicKey,
      admin: this.admin.publicKey,
      operator: this.operator.publicKey,
      validator: new PublicKey(MAGICBLOCK.teeValidator),
      studioAccount: this.studio.account,
      studioBps: 300,
      tables: 2,
      sponsorLamports: SOL,
      fuelLamports: SOL / 10n,
      fuel: 0,
      listedDays: 365,
      now: this.now,
    };
    const base: AccountReader = {
      getMultipleAccountsInfo: async (keys) =>
        keys.map((k) => {
          const info = this.info(k);
          if (!info || !this.delegated.has(k.toBase58())) return info;
          return { ...info, owner: DELEGATION_PROGRAM_ID, data: Buffer.from(this.committed.get(k.toBase58()) ?? info.data) };
        }),
    };
    const rollup: AccountReader = { getMultipleAccountsInfo: async (keys) => keys.map((k) => (this.delegated.has(k.toBase58()) ? this.info(k) : null)) };
    const facts = await readSetupFacts(base, rollup, input);
    expect(setupProblems(input, facts)).toEqual([]);
    const first = railcarSetupPlan(input, facts);
    const delegatedBy: Record<string, PublicKey> = { "delegate-sponsor": sponsorPdaOf(), "delegate-fuel-0": fuelPda(0), "delegate-table-0": tablePda(0), "delegate-table-1": tablePda(1) };
    for (const s of first) {
      if (s.status !== "to do") continue;
      const signer = s.signer === "operator" ? this.operator : this.admin;
      const target = delegatedBy[s.id];
      const before = target ? this.get(target)! : null;
      if (s.id.startsWith("init-vault-")) {
        const table = tablePda(Number(s.id.slice("init-vault-".length)));
        const size = (await blankVault(table)).length;
        this.svm.set(vaultPda(table), { lamports: Number(rentOfBytes(size)), data: new Uint8Array(size), owner: RAILCAR_PROGRAM_ID, executable: false });
      }
      this.send([cu(s.cu), ...s.ixs], signer);
      if (s.id === "tee-only") {
        const data = Buffer.concat([Buffer.alloc(8), u32(1), new PublicKey(MAGICBLOCK.teeValidator).toBuffer()]);
        this.svm.set(programConfigPda(), { lamports: 1_000_000, data, owner: DELEGATION_PROGRAM_ID, executable: false });
      }
      if (target && before) {
        // Railcar gave the account to the delegation program; the real one would keep its bytes and lend it to the rollup.
        expect(this.get(target)!.owner.equals(DELEGATION_PROGRAM_ID)).toBe(true);
        this.svm.set(target, before);
        this.delegated.add(target.toBase58());
        this.committed.set(target.toBase58(), Buffer.from(before.data));
      }
    }
    const again = railcarSetupPlan(input, await readSetupFacts(base, rollup, input));
    this.setupRun = { first, again };
    this.ensureSpill(this.studio, 64);
  }

  /** A Tesoro Account with no Gemas. */
  person(): Person {
    const kp = Keypair.generate();
    this.svm.airdrop(kp.publicKey, 100n * SOL);
    const account = accountOf(kp.publicKey);
    this.send([coreIx("create_account", { authority: kp.publicKey, account, basket: basketPda(account), spill: spillPda(account), invite_gate: corePda("invite_gate"), payer: kp.publicKey }, { evm_address: new Array(20).fill(0) })], kp);
    const seat = Keypair.generate();
    this.svm.airdrop(seat.publicKey, SOL);
    return { kp, key: kp.publicKey, account, seat };
  }

  /** A Player with 75,000 Gemas of a Source of their own (Position + Advance), and room in the spill. */
  rider(): Person {
    const p = this.person();
    this.stakes++;
    const id = Buffer.alloc(32, this.stakes);
    const position = corePda("position", Buffer.from([0]), id);
    const asset = Keypair.generate().publicKey;
    this.send([coreIx("open_position", { oracle: this.oracle.publicKey, config: corePda("config"), owner_account: p.account, position }, { source_chain: { Solana: {} }, position_id: Array.from(id), source_asset: asset, decimals: 9, principal: 100n * SOL, rate_bps: 1_000 })], this.oracle);
    const source = corePda("source", position.toBuffer(), u32(0));
    this.send(
      [
        coreIx(
          "take_advance",
          { oracle: this.oracle.publicKey, owner_authority: p.key, config: corePda("config"), treasury: corePda("treasury"), owner_account: p.account, protections: corePda("protections", p.account.toBuffer()), position, source, book: corePda("book", source.toBuffer()), basket: basketPda(p.account), spill: spillPda(p.account), economy: corePda("economy") },
          { horizon_months: 6, price_micro_usd: 150_000_000n, min_gemas: 1n },
          [{ pubkey: corePda("onchain_price", asset.toBuffer()), isSigner: false, isWritable: false }],
        ),
      ],
      this.oracle,
      [p.kp],
    );
    this.ensureSpill(p, 24);
    return p;
  }

  ensureSpill(p: Person, free: number) {
    const s = decodeStore(this.get(spillPda(p.account))!.data);
    let need = free - (s.capacity - s.len - s.roomReserved);
    while (need > 0) {
      const n = Math.min(need, 71);
      this.send([coreIx("grow_store", { payer: p.key, account: p.account, basket: basketPda(p.account), spill: spillPda(p.account) }, { which: { Spill: {} }, extra_lines: n })], p.kp);
      need -= n;
    }
  }

  /** Gemas in the Account's basket and spill, plus what waits for it in the car's overflow record (claimed into its stores later). */
  gemas(p: Person, car?: { opener: PublicKey; n: bigint }): bigint {
    const stores = [basketPda(p.account), spillPda(p.account)].reduce((sum, k) => sum + decodeStore(this.get(k)!.data).lines().reduce((a, l) => a + l.amount, 0n), 0n);
    const record = car ? this.info(matchOverflowPda(p.account, car)) : null;
    return stores + (record ? decodeStore(record.data, OVERFLOW_STORE_AT).lines().reduce((a, l) => a + l.amount, 0n) : 0n);
  }
  studioFee(): bigint {
    return [basketPda(this.studio.account), spillPda(this.studio.account)].reduce((sum, k) => sum + decodeStore(this.get(k)!.data).lines().filter((l) => l.cls === CLASS_STUDIO).reduce((a, l) => a + l.amount, 0n), 0n);
  }

  // ---- the app's steps -------------------------------------------------------------------------------------------------

  /** The Queue as the page boards: read the config and the boarding car, choose, and send the wallet's one transaction. */
  async board(p: Person, backing?: BoardingBacking): Promise<string> {
    const conn = this.reader();
    const config = decodeConfig(this.info(configPda())!.data);
    let boarding = null;
    if (config.nextCar > 0n) {
      const carNo = config.nextCar - 1n;
      const info = this.info(carPda(carNo));
      const loaded = info && (await loadCar(conn, decodeCarAccount(info.data).tesoroMatch));
      if (loaded) boarding = { car: loaded.car, carNo, pages: loaded.pages };
    }
    const backerSeated = !!backing && !!boarding && (await backerSeatedIn(conn, boarding.car.address, backing.backerAccount));
    const choice = queueChoice({ config, boarding, now: this.now, mine: false, backerSeated });
    if (choice.kind !== "join" && choice.kind !== "open") return choice.kind;
    // Sponsored, as the page sends it: the relayer pays, the wallet signs the entry once, the seat key co-signs.
    const payer = this.relayer.publicKey;
    const seatKey = p.seat;
    // A backed seat boards from its Offer's Backing Ticket, opened at the entry and staged by the seat key.
    let pot: ReturnType<typeof freshPot>;
    let remaining: AccountMeta[] = [];
    if (backing) {
      const t = await this.stageBacking(p, backing, seatKey);
      pot = { address: t.address, nonce: t.nonce, lines: t.lineCap, ticket: true };
    } else {
      const { funder, preview } = await boardingEntry(conn, p.account);
      expect(preview.needsTicket).toBe(false);
      pot = freshPot(funder, preview.potLines, await readNextTicket(funder, conn));
      remaining = await drawRemaining(preview.plan, conn);
    }
    const ixs: TransactionInstruction[] = [];
    if (choice.kind === "join") {
      ixs.push(joinSeatIx({ payer, player: p.key, car: choice.car, game: RAILCAR_PROGRAM_ID, page: choice.page, pot, backing, remaining, seatSigner: seatKey.publicKey }), checkDepartureIx(choice.carNo, choice.car));
    } else {
      const n = nextMatchOf(this.info(countersPda(p.account))?.data);
      const match = matchPda(p.account, n);
      const join = joinSeatIx({ payer, player: p.key, car: match, game: RAILCAR_PROGRAM_ID, page: 0, pot, backing, remaining, seatSigner: seatKey.publicKey });
      if (backing) {
        // A Backed Player opens the car first, as the page does: the open and a Backed join do not fit one transaction.
        this.send(sponsoredInstructions({ cu: 1_000_000, grows: [], ixs: [openCarIx({ payer, opener: p.key, config, n })], assignment: null }), this.relayer, [p.kp]);
        ixs.push(join, checkDepartureIx(choice.carNo, match));
      } else ixs.push(openCarIx({ payer, opener: p.key, config, n }), join, checkDepartureIx(choice.carNo, match));
    }
    this.send(sponsoredInstructions({ cu: 1_000_000, grows: [], ixs, assignment: null }), this.relayer, [p.kp, seatKey]);
    return choice.kind;
  }

  /** The Backing flow as the Backing page sends it: the Player's Request for Railcar at 500, the Backer's Offer, the Player accepting. */
  backing(player: Person, backer: Person, shareBps: number): BoardingBacking {
    const request = createRequestIx({ player: player.key, game: RAILCAR_PROGRAM_ID, entry: 500n, nonce: backingNonce() });
    this.send([request.ix], player.kp);
    const offer = createOfferIx({ backer: backer.key, request: request.address, game: RAILCAR_PROGRAM_ID, shareBps, nonce: backingNonce() });
    this.send([offer.ix], backer.kp);
    this.send([acceptOfferIx({ player: player.key, request: request.address, offer: offer.address })], player.kp);
    return { offer: offer.address, backerAccount: backer.account };
  }

  /**
   * The Backing Ticket a backed seat boards from, as the page readies it (`readyBackingTicket`): the Player opens it with
   * the first stage (wallet and seat key sign, the relayer pays), the seat key stages the rest.
   */
  async stageBacking(p: Person, backing: BoardingBacking, seatKey: Keypair): Promise<TicketView> {
    const conn = this.reader();
    if (!(await backingTicketOf(conn, backing.offer, backing.backerAccount))) {
      const lines = previewEntry(await readEntryStores(backing.backerAccount, conn), 500n, { backing: true }).ticketLines;
      const built = await openBackingTicketIxs({ payer: this.relayer.publicKey, requester: p.key, seat: seatKey.publicKey, backerAccount: backing.backerAccount, offer: backing.offer, game: RAILCAR_PROGRAM_ID, entry: 500n, lines, sponsored: true }, conn);
      this.send(sponsoredInstructions({ cu: 700_000, grows: [], ixs: built.ixs, assignment: null }), this.relayer, [p.kp, seatKey]);
    }
    for (let i = 0; i < 20; i++) {
      const t = await backingTicketOf(conn, backing.offer, backing.backerAccount);
      if (!t) throw new Error("the Offer has no open Backing Ticket");
      const ix = await nextStageIx(seatKey.publicKey, t, await readEntryStores(t.account, conn), conn);
      if (!ix) return t;
      this.send([ix], this.relayer, [seatKey]);
    }
    throw new Error("the Backing Ticket did not fill");
  }

  offerStatus(offer: PublicKey): string {
    const o = new BorshAccountsCoder(coreIdl as unknown as Idl).decode("OfferState", Buffer.from(this.get(offer)!.data)) as { inner: { status: object } };
    return Object.keys(o.inner.status)[0].toLowerCase();
  }

  /** sim_lst's pool and core's native custody and simSOL price, as programs/tesoro_core/tests/native.rs sets them up. */
  async nativeSetUp() {
    this.svm.addProgram(SIM_LST_ID, readFileSync(join(SO_DIR, "sim_lst.so")));
    const sim = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], SIM_LST_ID)[0];
    const disc = createHash("sha256").update("global:initialize").digest().subarray(0, 8);
    const args = Buffer.alloc(24);
    args.writeUInt32LE(700, 0); // 7% APY
    args.writeUInt32LE(4_380, 4); // devnet speed: 1 month = 10 min
    args.writeBigUInt64LE(10n * SOL, 8); // faucet amount
    args.writeBigInt64LE(3_600n, 16); // faucet cooldown
    const keys = [
      { pubkey: this.admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: SIM_SOL_MINT, isSigner: false, isWritable: true },
      { pubkey: sim("vault"), isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ];
    this.send([new TransactionInstruction({ programId: SIM_LST_ID, keys, data: Buffer.concat([disc, args]) })], this.admin);
    this.send([coreIx("init_native_custody", { admin: this.admin.publicKey, config: corePda("config"), pool: POOL, mint: SIM_SOL_MINT, custody: nativeCustodyPda(), vault: nativeVaultPda(), token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId })], this.admin);
    this.send([setPriceIx(this.oracle.publicKey, 150_000_000n)], this.oracle);
  }

  /** A Player whose Gemas come from a native Lock: test simSOL from the faucet, locked with a 6-month Advance (the app's builders). */
  nativeRider(): Person {
    const p = this.person();
    this.send([faucetIx(p.key)], p.kp);
    const nonce = BigInt(++this.stakes);
    const position = PublicKey.findProgramAddressSync([Buffer.from("position"), Buffer.from([0]), createHash("sha256").update(Buffer.concat([Buffer.from("native"), p.key.toBuffer(), u64(nonce)])).digest()], CORE)[0];
    this.send([cu(1_400_000), openNativePositionIx(p.key, nonce, 10n * SOL, position), takeNativeAdvanceIx(p.key, position, 0, 6, 1n)], p.kp);
    this.ensureSpill(p, 24);
    return p;
  }

  /** Stands in for a seat index's first `bind_brake` (the ephemeral-account CPI needs MagicBlock): the Brake seat exists, unbound. */
  async brakeSeatStandIn(index: number, seat: number) {
    const key = brakeSeatPda(tablePda(index), seat);
    if (this.get(key)) return;
    const bump = PublicKey.findProgramAddressSync([Buffer.from("brake"), tablePda(index).toBuffer(), Uint8Array.of(seat)], RAILCAR_PROGRAM_ID)[1];
    const data = await new BorshAccountsCoder(railcarIdl as unknown as Idl).encode("BrakeSeat", { version: 1, bump, table: tablePda(index), seat, bound: 0, car_no: new BN(0), used: 0, press_ms: 0, reserved: new Array(16).fill(0) });
    this.svm.set(key, { lamports: Number(SOL), data, owner: RAILCAR_PROGRAM_ID, executable: false });
  }

  rideSlot(index: number): bigint {
    return decodeTable(this.get(tablePda(index))!.data).rideSlot;
  }

  /** Ends with a commit stand-in when the step ended the ride: base keeps the Table's bytes. */
  rollup(ixs: TransactionInstruction[], signer: Keypair, index: number) {
    this.send(ixs, signer);
    const data = this.get(tablePda(index))!.data;
    const t = decodeTable(data);
    if (t.phase === "over" && data[8 + 16] === 0) this.committed.set(tablePda(index).toBase58(), Buffer.from(data));
  }

  /** `onBase` for an async `f`. */
  async onBaseAsync<T>(index: number, f: () => Promise<T>): Promise<T> {
    const key = tablePda(index);
    const live = this.get(key)!;
    this.svm.set(key, { lamports: live.lamports, data: this.committed.get(key.toBase58())!, owner: DELEGATION_PROGRAM_ID, executable: false });
    try {
      return await f();
    } finally {
      this.svm.set(key, live);
    }
  }

  /** Base's view of the Table (the committed bytes, owned by the delegation program) while `f` runs. */
  onBase<T>(index: number, f: () => T): T {
    const key = tablePda(index);
    const live = this.get(key)!;
    this.svm.set(key, { lamports: live.lamports, data: this.committed.get(key.toBase58())!, owner: DELEGATION_PROGRAM_ID, executable: false });
    try {
      return f();
    } finally {
      this.svm.set(key, live);
    }
  }
}

/** A VRF output whose ride satisfies `want` (the Rust tests' search, with the TypeScript engine). */
function drawWhere(want: (r: ReturnType<typeof ride>) => boolean): Uint8Array {
  const M = (1n << 64n) - 1n;
  for (let i = 0n; i < 100_000n; i++) {
    const d = new Uint8Array(32);
    for (let k = 0n; k < 4n; k++) {
      let z = ((i * 4n + k + 1n) * 0x9e3779b97f4a7c15n) & M;
      z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
      z ^= z >> 31n;
      d.set(u64(z), Number(k) * 8);
    }
    if (want(ride(d))) return d;
  }
  throw new Error("no draw found");
}

const sponsorPdaOf = () => PublicKey.findProgramAddressSync([Buffer.from("sponsor")], RAILCAR_PROGRAM_ID)[0];
const rentOfBytes = (n: number) => BigInt(n + 128) * 6_960n;

/** A Table's Vault as `init_vault` writes it: blank, for no car yet. */
async function blankVault(table: PublicKey): Promise<Buffer> {
  const bump = PublicKey.findProgramAddressSync([Buffer.from("vault"), table.toBuffer()], RAILCAR_PROGRAM_ID)[1];
  return new BorshAccountsCoder(railcarIdl as unknown as Idl).encode("Vault", { version: 1, bump, table, car_no: new BN(0), ready: false, draw: new Array(32).fill(0), crash_ms: 0, screw_at_ms: 0, bolt_at_ms: 0, spark_at_ms: 0, false_screws: [0, 0, 0, 0], false_len: 0, slow_end_ms: 0, slow_total_ms: 0, press_count: 0, presses: new Array(101).fill(0), press_seat: new Array(101).fill(0), reserved: new Array(128).fill(0) });
}

/** A VRF output whose crash point is exactly `crashMs` (the crash falls as the first word grows; the rest is fixed). */
function drawWithCrash(crashMs: number): Uint8Array {
  const at = (w0: bigint) => {
    const d = new Uint8Array(32).fill(0x5a);
    d.set(u64(w0), 0);
    return d;
  };
  let [lo, hi] = [0n, (1n << 64n) - 1n];
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    if (ride(at(mid)).crashMs > crashMs) lo = mid + 1n;
    else hi = mid;
  }
  expect(ride(at(lo)).crashMs).toBe(crashMs);
  return at(lo);
}

interface RideRun {
  riders: Person[];
  /** The backed rider's Backer and the Gemas they got back (after the car closed, against after boarding). */
  backer: { person: Person; delta: bigint; shown: { backerGets: bigint; playerGets: bigint } | null } | null;
  /** Gemas each rider got back (after the car closed, against after boarding). */
  deltas: bigint[];
  studioFee: bigint;
  chunkSteps: number[];
  /** Compute units each chunk used, as sent. */
  chunkUnits: number[];
  /** What the result screen shows each rider getting, read from the committed Table. */
  shown: bigint[];
  walletSigs: Record<string, number>;
  /** The ride as the Match history stores it from the finish's own events: each rider's row delta, and the replay. */
  history: { deltas: number[]; replay: RideReplay };
  finalizeUnits: number;
  revealUnits: number;
  setupRun: World["setupRun"];
}

/**
 * Boards `n` riders through the Queue, departs, rides with `draw`, Jumps rider `who` at `secs` (in that order), signals at
 * Impact, then finalizes, reserves room, runs every chunk and every close: everything after boarding and the Jumps is
 * sent by the relayer or the page key, never a rider's wallet. With `viaSponsor` the finish goes through the sponsor as
 * that rider's page sends it.
 */
let rooms = 0;

interface RideOpts {
  /** Railcar set up by the devnet setup script's plan (`World.setUpByScript`). */
  setup?: "script";
  brakes?: [number, number][];
  watch?: (w: World, at: { secs: number; table: PublicKey; riders: Person[] }) => void;
  backed?: { seat: number; shareBps: number };
  noSeatKey?: number[];
  /** The pages leave after the last Jump: nobody sends the signal that applies the Impact. */
  noImpact?: boolean;
  /** The finish goes through the sponsor as this rider's page sends it, vouched for by its seat key (not the relayer directly). */
  viaSponsor?: number;
  /** The riders' Gemas come from native Locks (simSOL), whose yield the clock accrues, instead of reported Positions. */
  native?: boolean;
  /** Seconds the riders' Advances age before they board (on a native Lock the clock accrues yield meanwhile). */
  aged?: number;
  /**
   * Another car in a World that already rode one, with the same riders: a fee the first ride cut from a rider's line gave
   * that Source holders in the fee classes, so the yield it earns since lands into their checkpoint pages, which its book
   * has never had (devnet car 2, 2026-11-08: core refused the chunk with AccountMissing until someone created them).
   */
  again?: { world: World; riders: Person[] };
  /** Called through the sponsor's page before the finish's own pages step (`viaSponsor` only). */
  beforePages?: (at: { w: World; sponsor: Sponsor; finisher: Person; match: PublicKey; ixs: TransactionInstruction[] }) => Promise<void>;
}

/** A car boarded, departed and ridden through `jumps` (and, unless `noImpact`, its Impact): everything before the finish. */
async function rideToImpact(n: number, draw: Uint8Array, jumps: [number, number][], o: RideOpts = {}) {
  const backed = o.backed;
  const w = o.again?.world ?? (await World.create({ setup: o.setup }));
  if (o.native && !o.again) await w.nativeSetUp();
  // A backed rider has no Gemas of their own: their Backer's entry boards for them.
  w.riders = o.again?.riders ?? Array.from({ length: n }, (_, i) => (i === backed?.seat ? w.person() : o.native ? w.nativeRider() : w.rider()));
  const riders = w.riders;
  // A Player who boards without a seat key names the wallet as the seat's signer (core: "the wallet itself when it wants none").
  const keyless = new Set(o.noSeatKey ?? []);
  for (const i of keyless) riders[i].seat = riders[i].kp;
  const backer = backed ? w.rider() : null;
  const backing = backed && backer ? w.backing(riders[backed.seat], backer, backed.shareBps) : undefined;
  if (o.aged) w.setTime(w.now + o.aged);

  // Boarding: the first opens the car, the others join it, each in one wallet transaction.
  w.phase = "boarding";
  for (const [i, p] of riders.entries()) await w.board(p, i === backed?.seat ? backing : undefined);
  const config = decodeConfig(w.info(configPda())!.data);
  const carNo = config.nextCar - 1n;
  const carAcct = decodeCarAccount(w.info(carPda(carNo))!.data);
  const match = carAcct.tesoroMatch;
  const id = (await loadCar(w.reader(), match))!.car;
  const before = riders.map((p) => w.gemas(p, id));
  const backerBefore = backer ? w.gemas(backer, id) : 0n;
  const studioBefore = w.studioFee();

  // Departure: 30 s after the 5th boarded (a full car left in the 100th's own transaction).
  w.phase = "finish";
  if ((await loadCar(w.reader(), match))!.car.stage === "boarding") {
    w.setTime(w.now + 30);
    w.send([checkDepartureIx(carNo, match)], w.relayer);
  }
  expect((await loadCar(w.reader(), match))!.car.stage).toBe("departed");

  // The ride: a page starts it, the VRF answers, Players Jump, a signal at Impact ends it.
  const loaded = (await loadCar(w.reader(), match))!;
  w.rollup([cu(1_400_000), startRideIx(w.pageKey.publicKey, { carNo, table: carAcct.table, tesoroMatch: match }, loaded.car.pages, null)], w.pageKey, carAcct.table);
  const table = tablePda(carAcct.table);
  const reqNonce = Buffer.from(w.get(table)!.data).readBigUInt64LE(8 + 120);
  const request = PublicKey.findProgramAddressSync([Buffer.from("vrfreq"), table.toBuffer(), u64(reqNonce)], RAILCAR_PROGRAM_ID)[0];
  const identity = PublicKey.findProgramAddressSync([Buffer.from("identity"), RAILCAR_PROGRAM_ID.toBuffer()], VRF)[0];
  w.send([railcarIx("draw_callback", { vrf_program_identity: identity, table, vault: vaultPda(table), request }, { randomness: Array.from(draw) })], w.oracle);
  expect(decodeTable(w.get(table)!.data).phase).toBe("riding");

  // Pages bind every seat's Brake seat, a page's own and the next ones per transaction, signed by page keys.
  for (let first = 0; decodeTable(w.get(table)!.data).brakesBound < n; first += BIND_PER_SEND) {
    const t = decodeTable(w.get(table)!.data);
    const seats = Array.from({ length: Math.min(BIND_PER_SEND, n - first) }, (_, k) => first + k);
    for (const i of seats) await w.brakeSeatStandIn(carAcct.table, i);
    w.send(seats.map((i) => bindBrakeIx(w.pageKey.publicKey, carAcct.table, carNo, i, t.seats[i].account)), w.pageKey);
  }

  const rideSlot = w.rideSlot(carAcct.table);
  const events = [...jumps.map(([who, secs]) => ({ who, secs, brake: false })), ...(o.brakes ?? []).map(([who, secs]) => ({ who, secs, brake: true }))].sort((a, b) => a.secs - b.secs || Number(a.brake) - Number(b.brake));
  for (const { who, secs, brake } of events) {
    w.setSlot(rideSlot + BigInt(Math.round(secs * 100)));
    const t = decodeTable(w.get(table)!.data);
    const seat = t.seats.find((s) => s.account.equals(riders[who].account))!;
    o.watch?.(w, { secs, table, riders });
    // The seat key the wallet named at boarding plays the Jump and the Brake's tick: the wallet is not asked. A Player
    // with no seat key on this page Jumps and Brakes with the wallet, as the page routes it.
    expect(seat.signer.equals(riders[who].seat.publicKey)).toBe(true);
    w.phase = brake ? "brakes" : "jumps";
    const pageSeatKey = keyless.has(who) ? null : riders[who].seat;
    const route = brakeRoute(riders[who].kp, pageSeatKey, seat.signer)!;
    expect(route.kind).toBe(keyless.has(who) ? "wallet" : "next-tick");
    const signer = route.signer;
    w.rollup([brake ? tickIx(signer.publicKey, carAcct.table, carNo, seat.tableSeat, true) : jumpIx(signer.publicKey, carAcct.table, carNo, seat.tableSeat)], signer, carAcct.table);
  }
  w.phase = "finish";
  const vault = new BorshAccountsCoder(railcarIdl as unknown as Idl).decode("Vault", Buffer.from(w.get(vaultPda(table))!.data)) as { crash_ms: number; press_count: number; presses: number[] };
  const impact = impactMs(vault.presses.slice(0, vault.press_count), vault.crash_ms);
  o.watch?.(w, { secs: impact / 1000 - 0.01, table, riders });
  w.setSlot(rideSlot + BigInt(Math.ceil(impact / 10)));
  const ctx = { w, riders, backer, backing, carNo, carAcct, match, id, before, backerBefore, studioBefore, table };
  if (o.noImpact) return { ...ctx, over: null, shown: [] as bigint[], backedRow: null };
  w.rollup([signalIx(w.pageKey.publicKey, carAcct.table)], w.pageKey, carAcct.table);
  const over = decodeTable(w.get(table)!.data);
  expect(over.phase).toBe("over");
  const seen = (await loadCar(w.reader(), match))!;
  const shownView = railcarView({ me: null, core: seen.car, seats: seen.seats, table: over, fees: { platformBps: 200, studioBps: 300, leaderboardBps: 100 }, nowMs: 0 });
  if (shownView.phase !== "result") throw new Error("the screen should show the result");
  const rowOf = (p: Person) => shownView.rows.find((r) => r.account === p.account.toBase58())!;
  // A backed row shows what the Player gets and, beside it, what goes back to the Backer.
  const shown = riders.map((p) => rowOf(p).backing?.playerGets ?? rowOf(p).gets);
  const backedRow = backed ? rowOf(riders[backed.seat]).backing ?? null : null;
  return { ...ctx, over, shown, backedRow };
}

async function rideCar(n: number, draw: Uint8Array, jumps: [number, number][], o: RideOpts = {}): Promise<RideRun & { over: ReturnType<typeof decodeTable>; finishSteps: string[]; credits: number; world: World }> {
  const { w, riders, backer, carNo, carAcct, match, id, before, backerBefore, studioBefore, table, over, shown, backedRow } = await rideToImpact(n, draw, jumps, o);
  if (!over) throw new Error("rideCar rides to the Impact");
  const sponsor = o.viaSponsor === undefined ? null : sponsorOn(w);
  const finisher = o.viaSponsor === undefined ? null : riders[o.viaSponsor];

  // The finish as a paid Player's page sends it (finish.ts), the relayer as caller of every step: finalize on base (the
  // committed Table), room, every chunk the planner sizes, every close. Sized and sent with no lookup table.
  const core = new Program(coreIdl as Idl, { connection: {} } as unknown as AnchorProvider);
  const chunkSteps: number[] = [];
  const chunkUnits: number[] = [];
  const finishTxs: InnerInstruction[][] = [];
  let finalizeUnits = 0;
  let revealUnits = 0;
  let credits = 0;
  const sent = await finishRide({
    read: w.reader(),
    core,
    caller: w.relayer.publicKey,
    carNo,
    match,
    committed: async () => {
      const t = decodeTable(w.committed.get(table.toBase58())!);
      return t.carNo === carNo && t.phase === "over";
    },
    fits: (ix) => fits(w.relayer.publicKey, [cu(1_400_000), ix]),
    fitsTx: (ixs) => fits(w.relayer.publicKey, [cu(1_400_000), ...ixs]),
    mine: finisher?.account,
    simulate: async (ix) => w.simulate([cu(1_400_000), ix], w.relayer.publicKey),
    send: async (ixs, step) => {
      const onBase = step === "finalize" || step === "reveal";
      if (sponsor && finisher) {
        if (step === "pages" && o.beforePages) await o.beforePages({ w, sponsor, finisher, match, ixs });
        // As the page sends it: the seat key's scope, then the sponsor's rules against the chain as it is, then its send.
        await (onBase ? w.onBaseAsync(carAcct.table, () => pageSend(w, sponsor, finisher, match, ixs)) : pageSend(w, sponsor, finisher, match, ixs));
      } else {
        const all = [cu(1_400_000), ...ixs];
        const go = () => w.send(all, w.relayer);
        if (onBase) w.onBase(carAcct.table, go);
        else go();
      }
      finishTxs.push(w.lastInner);
      if (step === "finalize") finalizeUnits = w.lastUnits;
      if (step === "reveal") revealUnits = w.lastUnits;
      if (step === "chunk") {
        chunkSteps.push(ixs[0].data[8]);
        chunkUnits.push(w.lastUnits);
        credits = decodeCar(match, w.get(match)!.data).run.steps;
      }
      if (step === "room") rooms++;
    },
  });
  expect(sent.done).toBe(true);
  expect(w.info(carPda(carNo))).toBeNull();
  expect(w.info(match)).toBeNull();
  // A page's own seat closes in the car's close transaction (its seat key names no seat after it).
  expect(sent.sent.filter((s) => s === "close-seat")).toHaveLength(finisher ? n - 1 : n);
  expect(sent.sent.at(-1)).toBe("close-car");

  // The Match history, written from the finish's transactions as the webhook writes it.
  const { rpc } = await testDb();
  for (const inner of finishTxs) await ingestMatchRecords(rpc, decodeMatchRecords(inner), { gameOf: () => null, finalized: true });
  const page = await matchPage(rpc, { opener: id.opener.toBase58(), n: id.n });
  const record = page && rideRecordOf(page);
  if (!record) throw new Error("the history has no ride for this car");
  const rows = await Promise.all(riders.map(async (p) => (await accountHistory(rpc, p.account.toBase58(), 1)).rows));
  const history = { deltas: rows.map((r) => (r.length === 1 && r[0].game === ("railcar" as string) ? r[0].delta : NaN)), replay: replayRide(record) };

  console.log(`Railcar transactions, ${n} riders, no lookup table (largest of each kind):\n${[...w.sizes].map(([k, s]) => `  ${s.bytes} B, ${s.accounts} accounts: ${k}`).join("\n")}`);
  return {
    riders,
    backer: backer ? { person: backer, delta: w.gemas(backer, id) - backerBefore, shown: backedRow && { backerGets: backedRow.backerGets, playerGets: backedRow.playerGets } } : null,
    deltas: riders.map((p, i) => w.gemas(p, id) - before[i]),
    studioFee: w.studioFee() - studioBefore,
    chunkSteps,
    chunkUnits,
    shown,
    walletSigs: w.walletSigs,
    over,
    history,
    finalizeUnits,
    revealUnits,
    finishSteps: sent.sent,
    credits,
    setupRun: w.setupRun,
    world: w,
  };
}

/** A sponsor whose chain is this LiteSVM: Railcar Listed, the relayer the World's. */
function sponsorOn(w: World): Sponsor {
  const chain: ChainReads = {
    getTransaction: async () => null,
    balance: async (k) => BigInt(w.get(k)?.lamports ?? 0),
    rent: async (bytes) => BigInt(bytes + 128) * 6_960n,
    account: async (k) => {
      const a = w.info(k);
      return a ? { owner: a.owner, data: a.data } : null;
    },
    // a fresh blockhash per build, so two equal steps are two transactions
    latestBlockhash: async () => {
      w.svm.expireBlockhash();
      return w.svm.latestBlockhash();
    },
    simulate: async (tx, watch) => w.svm.simulateWatch(tx, watch),
    send: async (raw) => w.sendRaw(raw),
  };
  return new Sponsor({ relayer: w.relayer, macKey: Buffer.from("litesvm"), store: new MemoryUsageStore(), limits: DEFAULT_LIMITS, chain, isListed: async (p) => p.equals(RAILCAR_PROGRAM_ID), lookupTables: async () => [], paused: async () => false, alertLowBalance: async () => undefined, lowBalance: 1n, now: () => Date.now() });
}

/**
 * One finish step as a Player's page sends it (`finishSender` → `sponsoredSend`): the seat key may ask only for what its
 * scope allows, the sponsor builds it under the seat-key rule (the car must name that key in the Player's seat) and sends it.
 * No signature but the relayer's: a finish step names the relayer as caller and payer.
 */
async function pageSend(w: World, sponsor: Sponsor, p: Person, match: PublicKey, ixs: TransactionInstruction[]): Promise<void> {
  assertSeatMay(ixs);
  const raw = { ixs: ixs.map((i) => ({ program: i.programId.toBase58(), keys: i.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })), data: Buffer.from(i.data).toString("base64") })) };
  const built = await sponsor.build(p.key, raw, null, { kind: "seat", signer: p.seat.publicKey, match });
  const tx = new VersionedTransaction(VersionedMessage.deserialize(Buffer.from(built.message, "base64")));
  await sponsor.submit(Buffer.from(tx.serialize()).toString("base64"), built.meta, built.mac);
}

/**
 * A Player's own step as the page sends it with the seat key (`sendStepOff` → `sponsoredSend`): built under the seat-key rule,
 * signed by the seat key, the relayer adds its signature. Returns who signed.
 */
async function seatSignedSend(sponsor: Sponsor, p: Person, match: PublicKey, ixs: TransactionInstruction[]): Promise<string[]> {
  assertSeatMay(ixs);
  const raw = { ixs: ixs.map((i) => ({ program: i.programId.toBase58(), keys: i.keys.map((k) => ({ pubkey: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })), data: Buffer.from(i.data).toString("base64") })) };
  const built = await sponsor.build(p.key, raw, null, { kind: "seat", signer: p.seat.publicKey, match });
  const msg = VersionedMessage.deserialize(Buffer.from(built.message, "base64"));
  const tx = new VersionedTransaction(msg);
  tx.sign([p.seat]);
  await sponsor.submit(Buffer.from(tx.serialize()).toString("base64"), built.meta, built.mac);
  return msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).map((k) => k.toBase58());
}

/** The keeper's sweep on this LiteSVM (one machine is base and rollup): its key calls and pays every step. */
function sweepOn(w: World, match: PublicKey, tableIndex: number, keeper: Keypair): SweepEnv {
  const core = new Program(coreIdl as Idl, { connection: {} } as unknown as AnchorProvider);
  return {
    base: w.reader(),
    rollup: w.reader(),
    core,
    caller: keeper.publicKey,
    match,
    now: w.now,
    fits: (ix) => fits(keeper.publicKey, [cu(1_400_000), ix]),
    simulate: async (ix) => w.simulate([cu(1_400_000), ix], keeper.publicKey),
    send: async (x) => {
      const ixs = [cu(x.units), ...x.ixs];
      if (x.layer === "rollup") w.rollup(ixs, keeper, tableIndex);
      else if (x.what === "reveal" || x.what === "finalize") w.onBase(tableIndex, () => w.send(ixs, keeper));
      else w.send(ixs, keeper);
    },
  };
}

/** Runs the sweep's step until the car is gone or `max` runs pass (one run per sweep, every five minutes). */
async function sweepUntilGone(w: World, match: PublicKey, tableIndex: number, keeper: Keypair, max = 6): Promise<string[]> {
  const sent: string[] = [];
  for (let i = 0; i < max && w.info(match); i++) {
    const r = await rideSweepStep(sweepOn(w, match, tableIndex, keeper));
    if ("wait" in r) throw new Error(`the sweep waits: ${r.wait}`);
    sent.push(...r.sent);
  }
  return sent;
}

describe.skipIf(!BUILT)("a Railcar ride in LiteSVM, sent with the app's builders and the shared planner", () => {
  it("the worked example pays to the Gema: boarding, departure, the ride, finalize, every chunk and close", { timeout: 120_000 }, async () => {
    const r = await rideCar(5, drawWhere((x) => x.crashMs >= 101_000), [
      [ANA, 25],
      [CY, 95],
      [BEN, 97],
      [DEE, 99],
    ]);
    // What each got back for the 500 they boarded with.
    expect(r.deltas).toEqual([350n, 630n, 578n, 813n, 0n]);
    expect(r.studioFee).toBe(64n);
    // The result screen shows what the chain paid.
    expect(r.shown).toEqual(r.deltas);
    // 11 steps in all (4 entries home, Ana's 150 cut three ways then to Dee, Eve's 500 to Dee, Ben, Cy).
    expect(r.credits).toBe(11);
    // The wallets signed boarding (5) and nothing else: the seat keys played the Jumps, the relayer and page key the finish.
    expect(r.walletSigs).toEqual({ boarding: 5 });
    // The Match history, from the finish's own events: every rider's row, and a replay that agrees with the chain.
    expect(r.history.deltas).toEqual([-150, 130, 78, 313, -500]);
    expect(r.history.replay.differences).toEqual([]);
    expect(r.history.replay.seats.map((s) => s.gets)).toEqual(r.deltas);
  });

  it("the devnet setup script's steps set Railcar up from nothing, a re-run finds nothing to do, and the worked example rides on it", { timeout: 120_000 }, async () => {
    const r = await rideCar(
      5,
      drawWhere((x) => x.crashMs >= 101_000),
      [
        [ANA, 25],
        [CY, 95],
        [BEN, 97],
        [DEE, 99],
      ],
      { setup: "script" },
    );
    const run = r.setupRun!;
    const ids = ["register-game", "list-game", "tee-only", "set-config", "create-sponsor", "create-fuel-0", "delegate-sponsor", "delegate-fuel-0", "create-table-0", "delegate-table-0", "create-table-1", "delegate-table-1", "init-vault-0", "init-vault-1"];
    expect(run.first.map((s) => [s.id, s.status])).toEqual(ids.map((id) => [id, "to do"]));
    expect(run.again.map((s) => [s.id, s.status])).toEqual(ids.map((id) => [id, "done"]));
    expect(r.deltas).toEqual([350n, 630n, 578n, 813n, 0n]);
    expect(r.studioFee).toBe(64n);
    expect(r.history.replay.differences).toEqual([]);
  });

  it("a secret Brake (the spec's example): the wall moves from 52 s to 54.5 s; the Table and Ben's screen never change; Ana's Brake seat holds it", { timeout: 120_000 }, async () => {
    const coder = new BorshAccountsCoder(railcarIdl as unknown as Idl);
    let before: { table: Uint8Array; ben: unknown; ana: unknown } | null = null;
    const screen = (t: ReturnType<typeof decodeTable>, who: Person, myBrakeMs: number | null) => railcarView({ me: who.account.toBase58(), core: null, seats: [], table: t, fees: { platformBps: 200, studioBps: 300, leaderboardBps: 100 }, nowMs: 0, myBrakeMs });
    const r = await rideCar(5, drawWithCrash(52_000), [
      [BEN, 50],
      [ANA, 53],
    ], {
      brakes: [[ANA, 48]],
      watch: (w, { secs, table, riders }) => {
        if (secs !== 48 && before === null) return;
        if (secs === 48) {
          // a signal in the same slot first, so the Brake's tick is compared with what any page's signal leaves
          w.rollup([signalIx(w.pageKey.publicKey, 0)], w.pageKey, 0);
          const t = decodeTable(w.get(table)!.data);
          before = { table: w.get(table)!.data, ben: screen(t, riders[BEN], null), ana: screen(t, riders[ANA], null) };
          return;
        }
        if (secs === 50 && before) {
          // after Ana's Brake (48 s): the public Table is byte for byte what it was, so every other screen is too
          const now = w.get(table)!.data;
          expect(Buffer.from(now).equals(Buffer.from(before.table))).toBe(true);
          expect(screen(decodeTable(now), riders[BEN], null)).toEqual(before.ben);
          // only Ana's own Brake seat says it, and only her page reads it (its permission names her keys)
          const anaSeat = decodeBrakeSeat(w.get(brakeSeatPda(table, 0))!.data);
          expect([anaSeat.bound, anaSeat.used, anaSeat.pressMs]).toEqual([true, true, 48_000]);
          expect(decodeBrakeSeat(w.get(brakeSeatPda(table, 1))!.data).used).toBe(false);
          expect(coder.decode("Vault", Buffer.from(w.get(vaultPda(table))!.data)).press_count).toBe(1);
          before = null;
        }
      },
    });
    // Ana's Jump at 53 s counted (without her Brake the wall stood at 52 s): two off, Ana last
    expect(r.over.overMs).toBe(54_500);
    expect(r.deltas).toEqual([1_445n, 905n, 0n, 0n, 0n]);
    expect(r.shown).toEqual(r.deltas);
    // the end made every Brake public: the engine recomputes the wall from the draw and the Brakes
    expect(r.over.revealed).toBe(true);
    expect(r.over.seats.map((x) => x.brakeMs)).toEqual([48_000, null, null, null, null]);
    expect(impactMs([48_000], ride(r.over.revealDraw).crashMs)).toBe(r.over.overMs);
    // The wallets signed boarding only: the seat keys played the Brake and the Jumps.
    expect(r.walletSigs).toEqual({ boarding: 5 });
  });

  it("Ana boarded without a seat key: her wallet signs the Brake (one prompt) and it counts as any Brake does", { timeout: 120_000 }, async () => {
    const r = await rideCar(5, drawWithCrash(52_000), [
      [BEN, 50],
      [ANA, 53],
    ], { brakes: [[ANA, 48]], noSeatKey: [ANA] });
    expect(r.over.overMs).toBe(54_500);
    expect(r.deltas).toEqual([1_445n, 905n, 0n, 0n, 0n]);
    expect(r.over.seats.map((x) => x.brakeMs)).toEqual([48_000, null, null, null, null]);
    // her wallet signed boarding, the Brake and her Jump; everyone else's seat key played for them
    expect(r.walletSigs).toEqual({ boarding: 5, brakes: 1, jumps: 1 });
  });

  it("Ben rides backed by Bob (40% to Ben): Bob's 500 board for him, second place splits 52 to Ben and 578 to Bob", { timeout: 120_000 }, async () => {
    const r = await rideCar(
      5,
      drawWhere((x) => x.crashMs >= 101_000),
      [
        [ANA, 25],
        [CY, 95],
        [BEN, 97],
        [DEE, 99],
      ],
      { backed: { seat: BEN, shareBps: 4_000 } },
    );
    // Ben's place pays 630: Bob's 500 back first, then 130 split 40/60 (Ben floor(52), Bob 78). The others as unbacked.
    expect(r.deltas).toEqual([350n, 52n, 578n, 813n, 0n]);
    expect(r.backer!.delta).toBe(578n);
    expect(r.studioFee).toBe(64n);
    // The result screen shows the split the chain paid.
    expect(r.shown).toEqual(r.deltas);
    expect(r.backer!.shown).toEqual({ backerGets: 578n, playerGets: 52n });
    // Ben signed his Request, the acceptance, the opening of his Backing Ticket and his boarding (6 in boarding: his two
    // and the four others'); Bob nothing after his Offer; the seat keys played the Jumps.
    expect(r.walletSigs).toEqual({ setup: 2, boarding: 6 });
  });

  it("a backed step-off sends the Backer's 500 home and leaves the Player free to board again", { timeout: 120_000 }, async () => {
    const w = await World.create();
    const ben = w.person();
    const bob = w.rider();
    const bobAtStart = w.gemas(bob);
    const backing = w.backing(ben, bob, 4_000);
    expect(await w.board(ben, backing)).toBe("open");
    const config = decodeConfig(w.info(configPda())!.data);
    const match = decodeCarAccount(w.info(carPda(config.nextCar - 1n))!.data).tesoroMatch;
    const loaded = (await loadCar(w.reader(), match))!;
    const seat = loaded.seats.find((s) => s.seated)!;
    expect(seat.player).toEqual(ben.account);
    expect(seat.funder).toEqual(bob.account);
    expect(seat.shareBps).toBe(4_000);
    expect(w.gemas(bob)).toBe(bobAtStart - 500n);
    expect(w.gemas(ben)).toBe(0n);

    // Ben steps off with the page's builder: Bob's 500 come home, unreserved; the Offer stays used.
    const core = new Program(coreIdl as Idl, { connection: {} } as unknown as AnchorProvider);
    w.send([cu(1_000_000), await stepOffFor(core, w.reader(), { caller: ben.key, loaded, seat })], ben.kp);
    expect(w.gemas(bob)).toBe(bobAtStart);
    expect(w.gemas(ben)).toBe(0n);
    expect(w.info(seatMarkPda(match, ben.account))).toBeNull();
    expect(w.info(seatMarkPda(match, bob.account))).toBeNull();
    expect(w.offerStatus(backing.offer)).toBe("consumed");
    // Ben's seat is free again: he can board the same car (here with Gemas of his own from a second Backing).
    const ann = w.rider();
    expect(await w.board(ben, w.backing(ben, ann, 5_000))).toBe("join");
    console.log(`Railcar transactions, a Backed opener and step-off, no lookup table:\n${[...w.sizes].map(([k, s]) => `  ${s.bytes} B, ${s.accounts} accounts: ${k}`).join("\n")}`);
  });

  it("Ben steps off with his seat key through the sponsor: only the relayer and the seat key sign, and his 500 come home", { timeout: 120_000 }, async () => {
    const w = await World.create();
    const ben = w.rider();
    const before = w.gemas(ben);
    expect(await w.board(ben)).toBe("open");
    const config = decodeConfig(w.info(configPda())!.data);
    const match = decodeCarAccount(w.info(carPda(config.nextCar - 1n))!.data).tesoroMatch;
    const loaded = (await loadCar(w.reader(), match))!;
    const seat = loaded.seats.find((s) => s.seated)!;
    expect(seat.signer).toEqual(ben.seat.publicKey);
    expect(w.gemas(ben)).toBe(before - 500n);
    const core = new Program(coreIdl as Idl, { connection: {} } as unknown as AnchorProvider);
    const signers = await seatSignedSend(sponsorOn(w), ben, match, [await stepOffFor(core, w.reader(), { caller: ben.seat.publicKey, loaded, seat })]);
    expect(signers.sort()).toEqual([w.relayer.publicKey.toBase58(), ben.seat.publicKey.toBase58()].sort());
    expect(w.gemas(ben)).toBe(before);
    expect(w.info(seatMarkPda(match, ben.account))).toBeNull();
  });

  it("a Backer already in the car: the Player is told to board the next one and nothing is sent", { timeout: 120_000 }, async () => {
    const w = await World.create();
    const bob = w.rider();
    const ben = w.person();
    expect(await w.board(bob)).toBe("open");
    const backing = w.backing(ben, bob, 4_000);
    expect(await w.board(ben, backing)).toBe("backer-seated");
    expect(w.offerStatus(backing.offer)).toBe("accepted");
  });

  it("100 Players: the car leaves full, 90 Jump, every page and chunk the planner sizes settles it to the Gema", { timeout: 600_000 }, async () => {
    // Seat i Jumps at 10 + 0.9 i seconds for i < 90; the last ten stay aboard.
    const jumps: [number, number][] = Array.from({ length: 90 }, (_, i) => [i, 10 + 0.9 * i]);
    const r = await rideCar(100, drawWhere((x) => x.crashMs >= 92_000), jumps);
    expect(r.shown).toEqual(r.deltas);
    // Places: the last three off (seats 89, 88, 87) get their entry back and more; the ten aboard lose theirs.
    expect(r.deltas.slice(87, 90).every((d) => d > 500n)).toBe(true);
    expect(r.deltas.slice(90)).toEqual(Array(10).fill(0n));
    // Every Gema is accounted for: what came back plus the fees is every entry.
    const back = r.deltas.reduce((a, b) => a + b, 0n);
    expect(back + r.studioFee).toBeLessThan(50_000n);
    expect(r.studioFee).toBeGreaterThan(0n);
    expect(r.walletSigs).toEqual({ boarding: 100 });
    // First place's stores could not hold every credit: the page reserved its overflow record before the forfeits moved.
    expect(rooms).toBeGreaterThan(0);
    expect(r.chunkSteps.every((s) => s >= 1 && s <= 7)).toBe(true);
    // The planner simulates each chunk and takes fewer steps until it is under the compute target (ticket 19).
    console.log(`chunks: ${r.chunkUnits.length}, worst ${Math.max(...r.chunkUnits)} CU, steps ${[...new Set(r.chunkSteps)].sort().join("/")}`);
    expect(r.chunkUnits.filter((u, i) => u > CHUNK_CU_TARGET && r.chunkSteps[i] > 1)).toEqual([]);
    // The history names all 100 and the replay agrees with the chain to the Gema; finalize still fits one transaction.
    expect(r.history.deltas).toEqual(r.deltas.map((d) => Number(d) - 500));
    expect(r.history.replay.differences).toEqual([]);
    expect(r.history.replay.seats.map((s) => s.gets)).toEqual(r.deltas);
    console.log(`reveal_ride, 100 seats: ${r.revealUnits} CU; finalize: ${r.finalizeUnits} CU`);
    expect(r.revealUnits).toBeLessThan(140_000);
  });

  // ---- the finish as it is really sent: a page through the sponsor, and the keeper's sweep ------------------------------

  const WORKED: [number, number][] = [
    [ANA, 25],
    [CY, 95],
    [BEN, 97],
    [DEE, 99],
  ];

  it("Dee's page finishes the worked example through the sponsor, vouched for by her seat key alone: reveal, finalize, room, chunks, closes", { timeout: 120_000 }, async () => {
    const r = await rideCar(5, drawWhere((x) => x.crashMs >= 101_000), WORKED, { viaSponsor: DEE });
    expect(r.finishSteps.slice(0, 2)).toEqual(["reveal", "finalize"]);
    expect(r.deltas).toEqual([350n, 630n, 578n, 813n, 0n]);
    expect(r.studioFee).toBe(64n);
    // Dee's wallet signed her boarding and nothing after it.
    expect(r.walletSigs).toEqual({ boarding: 5 });
    expect(r.history.deltas).toEqual([-150, 130, 78, 313, -500]);
  });

  it("every page left before the Impact: the keeper's sweep applies it, reveals the ride, finalizes and pays the worked example", { timeout: 120_000 }, async () => {
    const c = await rideToImpact(5, drawWhere((x) => x.crashMs >= 101_000), WORKED, { noImpact: true });
    const keeper = Keypair.generate();
    c.w.svm.airdrop(keeper.publicKey, 100n * SOL);
    c.w.setTime(c.w.now + 15 * 60);
    const steps = await sweepUntilGone(c.w, c.match, c.carAcct.table, keeper);
    expect(steps[0]).toMatch(/^signal/);
    expect(steps.slice(1, 3)).toEqual(["reveal", "finalize"]);
    expect(steps.at(-1)).toBe("close-car");
    expect(c.w.info(c.match)).toBeNull();
    expect(c.w.info(carPda(c.carNo))).toBeNull();
    expect(c.riders.map((p, i) => c.w.gemas(p, c.id) - c.before[i])).toEqual([350n, 630n, 578n, 813n, 0n]);
  });

  // ---- a fee cut that lands yield into checkpoint pages the Source's book never had (devnet car 2, 2026-11-08) ----------

  /**
   * The worked example on native Locks, then a month of devnet yield, then the second car's riders are the same five: the
   * second ride's fee is cut from Ana's Lock again, whose Studio and Leaderboard holders (the first ride's fees) need
   * checkpoint pages for the yield it lands.
   */
  const SECOND = async (o: RideOpts = {}) => {
    const first = await rideCar(5, drawWhere((x) => x.crashMs >= 101_000), WORKED, { native: true });
    expect(first.deltas).toEqual([350n, 630n, 578n, 813n, 0n]);
    return { native: true, aged: 10 * 60, again: { world: first.world, riders: first.riders }, ...o } satisfies RideOpts;
  };

  it("a second car after a month of yield: the page's finish creates the checkpoint pages Ana's Lock needs and pays the worked example to the Gema", { timeout: 180_000 }, async () => {
    const r = await rideCar(5, drawWhere((x) => x.crashMs >= 101_000), WORKED, await SECOND());
    expect(r.deltas).toEqual([350n, 630n, 578n, 813n, 0n]);
    expect(r.studioFee).toBe(64n);
    expect(r.walletSigs).toEqual({ boarding: 10 });
  });

  it("the same second car finished by Dee's page through the sponsor, vouched for by her seat key alone", { timeout: 180_000 }, async () => {
    const r = await rideCar(5, drawWhere((x) => x.crashMs >= 101_000), WORKED, await SECOND({ viaSponsor: DEE }));
    expect(r.deltas).toEqual([350n, 630n, 578n, 813n, 0n]);
    expect(r.walletSigs).toEqual({ boarding: 10 });
  });

  it("Dee's seat key has the relayer pay for the pages the car's fee cut writes, and not for a rider's Lock the car never cuts, though its book could use them", { timeout: 180_000 }, async () => {
    let refused = 0;
    const beforePages: RideOpts["beforePages"] = async ({ w, sponsor, finisher, match, ixs }) => {
      const cut = new Set(ixs.map((ix) => ix.keys[1].pubkey.toBase58()));
      const l = (await loadCar(w.reader(), match))!;
      const uncut = [...new Set(l.lines.flat().map((x) => x.source.toBase58()))].map((k) => new PublicKey(k)).find((src) => !cut.has(bookPda(src).toBase58()) && w.info(bookPda(src)) && !w.info(ckptPda(src, 1, 0)));
      if (!uncut) throw new Error("no rider's Source is left uncut with a book and a missing page");
      await expect(pageSend(w, sponsor, finisher, match, [initCkptPageIx(w.relayer.publicKey, uncut, 1, 0)])).rejects.toMatchObject({ code: "not-this-match" });
      refused++;
    };
    // The first car's fee cut is the one that needs Ana's pages: both cars finish through Dee's seat key.
    const first = await rideCar(5, drawWhere((x) => x.crashMs >= 101_000), WORKED, { native: true, viaSponsor: DEE, beforePages });
    expect(refused).toBe(1);
    expect(first.finishSteps).toContain("pages");
    expect(first.deltas).toEqual([350n, 630n, 578n, 813n, 0n]);
    const second = await rideCar(5, drawWhere((x) => x.crashMs >= 101_000), WORKED, { native: true, aged: 10 * 60, again: { world: first.world, riders: first.riders }, viaSponsor: DEE, beforePages });
    expect(second.deltas).toEqual([350n, 630n, 578n, 813n, 0n]);
  });

  it("the same second car with every page gone: the keeper's sweep finishes it and pays the worked example", { timeout: 180_000 }, async () => {
    const c = await rideToImpact(5, drawWhere((x) => x.crashMs >= 101_000), WORKED, await SECOND({ noImpact: true }));
    const keeper = Keypair.generate();
    c.w.svm.airdrop(keeper.publicKey, 100n * SOL);
    c.w.setTime(c.w.now + 15 * 60);
    const steps = await sweepUntilGone(c.w, c.match, c.carAcct.table, keeper);
    expect(steps.at(-1)).toBe("close-car");
    expect(c.riders.map((p, i) => c.w.gemas(p, c.id) - c.before[i])).toEqual([350n, 630n, 578n, 813n, 0n]);
  });

  it("a ride over on base that nobody finalized: from 24 h after departure the sweep refunds it through core, closes it and its Car", { timeout: 120_000 }, async () => {
    const c = await rideToImpact(5, drawWhere((x) => x.crashMs >= 101_000), WORKED);
    const keeper = Keypair.generate();
    c.w.svm.airdrop(keeper.publicKey, 100n * SOL);
    c.w.setTime((await loadCar(c.w.reader(), c.match))!.car.refundAfter);
    const steps = await sweepUntilGone(c.w, c.match, c.carAcct.table, keeper);
    expect(steps[0]).toBe("refund");
    expect(steps).not.toContain("finalize");
    expect(steps).toContain("close-ride");
    expect(c.w.info(c.match)).toBeNull();
    expect(c.w.info(carPda(c.carNo))).toBeNull();
    // Every entry home in full: a refund charges no fee.
    expect(c.riders.map((p, i) => c.w.gemas(p, c.id) - c.before[i])).toEqual(Array(5).fill(500n));
  });

  it("four boarded and the fifth never came: once core's boarding ends the sweep steps all four off home, closes the car and frees the Table", { timeout: 120_000 }, async () => {
    const w = await World.create();
    const riders = Array.from({ length: 4 }, () => w.rider());
    const atStart = riders.map((p) => w.gemas(p));
    for (const p of riders) await w.board(p);
    const config = decodeConfig(w.info(configPda())!.data);
    const carNo = config.nextCar - 1n;
    const car = decodeCarAccount(w.info(carPda(carNo))!.data);
    const loaded = (await loadCar(w.reader(), car.tesoroMatch))!;
    expect([loaded.car.stage, loaded.car.seated]).toEqual(["boarding", 4]);
    expect(riders.map((p, i) => atStart[i] - w.gemas(p))).toEqual(Array(4).fill(500n));
    const keeper = Keypair.generate();
    w.svm.airdrop(keeper.publicKey, 100n * SOL);
    // An hour before the car's deadline nobody may join or depart it any more.
    w.setTime(loaded.car.deadlineAbs - 3_600);
    const steps = await sweepUntilGone(w, car.tesoroMatch, car.table, keeper, 1);
    expect(steps.filter((x) => x.startsWith("step_off"))).toHaveLength(4);
    expect(steps.slice(-3).map((x) => x.split(" ")[0])).toEqual(["close_many_seat_match", "skip_car", "close_car"]);
    expect(w.info(car.tesoroMatch)).toBeNull();
    expect(w.info(carPda(carNo))).toBeNull();
    expect(riders.map((p) => w.gemas(p))).toEqual(atStart);
    expect(decodeTable(w.get(tablePda(car.table))!.data).nextCar).toBe(carNo + BigInt(config.tables));
    // The Queue opens the next car.
    expect(await w.board(w.rider())).toBe("open");
  });
});
