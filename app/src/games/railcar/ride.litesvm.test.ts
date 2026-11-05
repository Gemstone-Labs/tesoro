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
  VersionedTransaction,
  type AccountInfo,
  type TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CLASS_STUDIO, basketPda, countersPda, matchPda, spillPda } from "../../lib/chain/basket";
import { coreIx } from "../../lib/chain/core-ix";
import { drawRemaining, freshPot, nextMatchOf, readNextTicket } from "../../lib/chain/entry";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import railcarIdl from "../../lib/chain/idl/railcar.json";
import { acceptOfferIx, backingNonce, createOfferIx, createRequestIx } from "../../lib/chain/backing-ix";
import { joinSeatIx, seatMarkPda } from "../../lib/chain/many-seat";
import { loadCar } from "../../lib/chain/many-seat-plan";
import { decodeStore } from "../../lib/chain/pot-store";
import { OVERFLOW_STORE_AT, matchOverflowPda } from "../../lib/chain/overflow";
import { fits, type Reader } from "../../lib/chain/settle-plan";
import { checkedV0, instructionName, messageSize, type TxSize } from "../../lib/chain/tx-size";
import { sponsoredInstructions } from "../../server/sponsor/service";
import {
  RAILCAR_PROGRAM_ID,
  checkDepartureIx,
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
import { ride } from "./engine";
import { queueChoice } from "./flow";
import { railcarView } from "./view";
import { finishRide } from "./finish";
import { backerSeatedIn, boardingEntry, stepOffFor, type BoardingBacking } from "./boarding";

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
  sendVersionedTransaction(bytes: Uint8Array): { logs?(): string[]; meta?(): { logs(): string[] }; err?(): unknown };
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
  send(tx: VersionedTransaction): { logs: string[]; err: unknown } {
    const r = this.inner.sendVersionedTransaction(tx.serialize());
    const logs = r.meta ? r.meta().logs() : r.logs!();
    return { logs, err: r.err ? r.err() : null };
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

  static async create(): Promise<World> {
    const w = new World();
    w.svm = await Svm.create();
    w.svm.addUpgradeable(CORE, readFileSync(join(SO_DIR, "tesoro_core.so")));
    w.svm.addUpgradeable(RAILCAR_PROGRAM_ID, readFileSync(join(SO_DIR, "railcar.so")));
    const noop = readFileSync(join(__dirname, "test-programs/noop.so"));
    for (const id of [MAGIC, PERMISSION_PROGRAM_ID, VRF]) w.svm.addProgram(id, noop);
    for (const k of [w.admin, w.oracle, w.ctl, w.operator, w.relayer, w.pageKey]) w.svm.airdrop(k.publicKey, 1_000n * SOL);
    w.setTime(T0);
    await w.setUp();
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
    const res = this.svm.send(tx);
    this.lastLogs = res.logs;
    if (res.err) throw new Error(`transaction failed: ${String(res.err)}\n${this.lastLogs.join("\n")}`);
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

  async setUp() {
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
    const vaultCoder = new BorshAccountsCoder(railcarIdl as unknown as Idl);
    for (const index of [0, 1]) {
      const table = tablePda(index);
      this.send([railcarIx("create_table", { operator: this.operator.publicKey, config: configPda(), table }, { index })], this.operator);
      // `init_vault` stand-in: the Vault exists, blank, and the Table says so.
      const [vault, vbump] = PublicKey.findProgramAddressSync([Buffer.from("vault"), table.toBuffer()], RAILCAR_PROGRAM_ID);
      const blank = await vaultCoder.encode("Vault", { bump: vbump, table, car_no: new BN(0), ready: false, draw: new Array(32).fill(0), crash_ms: 0, screw_at_ms: 0, bolt_at_ms: 0, spark_at_ms: 0, false_screws: [0, 0, 0, 0], false_len: 0, reserved: new Array(64).fill(0) });
      this.svm.set(vault, { lamports: Number(SOL), data: blank, owner: RAILCAR_PROGRAM_ID, executable: false });
      const t = this.get(table)!;
      const td = Buffer.from(t.data);
      td[8 + 15] = 1;
      this.svm.set(table, { ...t, data: td });
      this.committed.set(table.toBase58(), td);
    }
  }

  /** A Tesoro Account with no Gemas. */
  person(): Person {
    const kp = Keypair.generate();
    this.svm.airdrop(kp.publicKey, 100n * SOL);
    const account = accountOf(kp.publicKey);
    this.send([coreIx("create_account", { authority: kp.publicKey, account, basket: basketPda(account), spill: spillPda(account), invite_gate: corePda("invite_gate"), payer: kp.publicKey }, { evm_address: new Array(20).fill(0) })], kp);
    return { kp, key: kp.publicKey, account };
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
      const car = decodeCarAccount(this.info(carPda(carNo))!.data);
      const loaded = await loadCar(conn, car.tesoroMatch);
      if (loaded) boarding = { car: loaded.car, carNo, pages: loaded.pages };
    }
    const backerSeated = !!backing && !!boarding && (await backerSeatedIn(conn, boarding.car.address, backing.backerAccount));
    const choice = queueChoice({ config, boarding, now: this.now, mine: false, backerSeated });
    if (choice.kind !== "join" && choice.kind !== "open") return choice.kind;
    const { funder, preview } = await boardingEntry(conn, p.account, backing);
    expect(preview.needsTicket).toBe(false);
    const pot = freshPot(funder, preview.potLines, await readNextTicket(funder, conn));
    const remaining = await drawRemaining(preview.plan, conn);
    // Sponsored, as the page sends it: the relayer pays, the wallet signs the entry once, the seat key co-signs.
    const payer = this.relayer.publicKey;
    const seatKey = Keypair.generate();
    const ixs: TransactionInstruction[] = [];
    if (choice.kind === "join") {
      ixs.push(joinSeatIx({ payer, player: p.key, car: choice.car, game: RAILCAR_PROGRAM_ID, page: choice.page, pot, backing, remaining, seatSigner: seatKey.publicKey }), checkDepartureIx(choice.carNo, choice.car));
    } else {
      const n = nextMatchOf(this.info(countersPda(p.account))?.data);
      const match = matchPda(p.account, n);
      ixs.push(openCarIx({ payer, opener: p.key, config, n }), joinSeatIx({ payer, player: p.key, car: match, game: RAILCAR_PROGRAM_ID, page: 0, pot, backing, remaining, seatSigner: seatKey.publicKey }), checkDepartureIx(choice.carNo, match));
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

  offerStatus(offer: PublicKey): string {
    const o = new BorshAccountsCoder(coreIdl as unknown as Idl).decode("OfferState", Buffer.from(this.get(offer)!.data)) as { inner: { status: object } };
    return Object.keys(o.inner.status)[0].toLowerCase();
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

interface RideRun {
  riders: Person[];
  /** The backed rider's Backer and the Gemas they got back (after the car closed, against after boarding). */
  backer: { person: Person; delta: bigint; shown: { backerGets: bigint; playerGets: bigint } | null } | null;
  /** Gemas each rider got back (after the car closed, against after boarding). */
  deltas: bigint[];
  studioFee: bigint;
  chunkSteps: number[];
  /** What the result screen shows each rider getting, read from the committed Table. */
  shown: bigint[];
  walletSigs: Record<string, number>;
}

/**
 * Boards `n` riders through the Queue, departs, rides with `draw`, Jumps rider `who` at `secs` (in that order), signals at
 * Impact, then finalizes, reserves room, runs every chunk and every close: everything after boarding and the Jumps is
 * sent by the relayer or the page key, never a rider's wallet.
 */
let rooms = 0;
async function rideCar(n: number, draw: Uint8Array, jumps: [number, number][], backed?: { seat: number; shareBps: number }): Promise<RideRun> {
  const w = await World.create();
  // A backed rider has no Gemas of their own: their Backer's entry boards for them.
  w.riders = Array.from({ length: n }, (_, i) => (i === backed?.seat ? w.person() : w.rider()));
  const riders = w.riders;
  const backer = backed ? w.rider() : null;
  const backing = backed && backer ? w.backing(riders[backed.seat], backer, backed.shareBps) : undefined;

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

  w.phase = "jumps";
  const rideSlot = w.rideSlot(carAcct.table);
  for (const [who, secs] of jumps) {
    w.setSlot(rideSlot + BigInt(Math.round(secs * 100)));
    const t = decodeTable(w.get(table)!.data);
    const seat = t.seats.find((s) => s.account.equals(riders[who].account))!;
    // The wallet signs the Jump until Railcar takes the seat key (seat keys ticket 08).
    w.rollup([jumpIx(riders[who].key, riders[who].key, carAcct.table, carNo, seat.tableSeat)], riders[who].kp, carAcct.table);
  }
  w.phase = "finish";
  const vault = new BorshAccountsCoder(railcarIdl as unknown as Idl).decode("Vault", Buffer.from(w.get(vaultPda(table))!.data)) as { crash_ms: number };
  w.setSlot(rideSlot + BigInt(Math.ceil(vault.crash_ms / 10)));
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

  // The finish as a paid Player's page sends it (finish.ts), the relayer as caller of every step: finalize on base (the
  // committed Table), room, every chunk the planner sizes, every close. Sized and sent with no lookup table.
  const core = new Program(coreIdl as Idl, { connection: {} } as unknown as AnchorProvider);
  const chunkSteps: number[] = [];
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
    send: async (ixs, step) => {
      const all = [cu(1_400_000), ...ixs];
      const go = () => w.send(all, w.relayer);
      if (step === "finalize") w.onBase(carAcct.table, go);
      else go();
      if (step === "chunk") chunkSteps.push(ixs[0].data[8]);
      if (step === "room") rooms++;
    },
  });
  expect(sent.done).toBe(true);
  expect(w.info(carPda(carNo))).toBeNull();
  expect(w.info(match)).toBeNull();
  expect(sent.sent.filter((s) => s === "close-seat")).toHaveLength(n);
  expect(sent.sent.at(-1)).toBe("close-car");

  console.log(`Railcar transactions, ${n} riders, no lookup table (largest of each kind):\n${[...w.sizes].map(([k, s]) => `  ${s.bytes} B, ${s.accounts} accounts: ${k}`).join("\n")}`);
  return {
    riders,
    backer: backer ? { person: backer, delta: w.gemas(backer, id) - backerBefore, shown: backedRow && { backerGets: backedRow.backerGets, playerGets: backedRow.playerGets } } : null,
    deltas: riders.map((p, i) => w.gemas(p, id) - before[i]),
    studioFee: w.studioFee() - studioBefore,
    chunkSteps,
    shown,
    walletSigs: w.walletSigs,
  };
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
    expect(r.chunkSteps.reduce((a, b) => a + b, 0)).toBe(11);
    // The wallets signed boarding (5) and the Jumps (4, until the seat key plays them); nothing of the finish.
    expect(r.walletSigs).toEqual({ boarding: 5, jumps: 4 });
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
      { seat: BEN, shareBps: 4_000 },
    );
    // Ben's place pays 630: Bob's 500 back first, then 130 split 40/60 (Ben floor(52), Bob 78). The others as unbacked.
    expect(r.deltas).toEqual([350n, 52n, 578n, 813n, 0n]);
    expect(r.backer!.delta).toBe(578n);
    expect(r.studioFee).toBe(64n);
    // The result screen shows the split the chain paid.
    expect(r.shown).toEqual(r.deltas);
    expect(r.backer!.shown).toEqual({ backerGets: 578n, playerGets: 52n });
    // Ben signed his Request, the acceptance and his boarding; Bob nothing after his Offer.
    expect(r.walletSigs).toEqual({ setup: 2, boarding: 5, jumps: 4 });
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
    expect(r.walletSigs).toEqual({ boarding: 100, jumps: 90 });
    // First place's stores could not hold every credit: the page reserved its overflow record before the forfeits moved.
    expect(rooms).toBeGreaterThan(0);
    expect(r.chunkSteps.every((s) => s >= 1 && s <= 7)).toBe(true);
  });
});
