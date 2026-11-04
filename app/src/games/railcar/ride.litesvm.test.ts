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
 * `finalize` reads them owned by the delegation program. The lookup tables are written in place (the server's own tables
 * on devnet).
 */
import { AnchorProvider, BN, BorshAccountsCoder, Program, type Idl } from "@coral-xyz/anchor";
import { DELEGATION_PROGRAM_ID, PERMISSION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
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
import { drawRemaining, freshPot, nextMatchOf, previewEntry, readEntryStores, readNextTicket } from "../../lib/chain/entry";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import railcarIdl from "../../lib/chain/idl/railcar.json";
import { joinSeatIx } from "../../lib/chain/many-seat";
import { closeIxs, loadCar, planSeatChunk, roomIxs } from "../../lib/chain/many-seat-plan";
import { decodeStore } from "../../lib/chain/pot-store";
import { MAX_ACCOUNTS, MAX_TX_BYTES, type Reader } from "../../lib/chain/settle-plan";
import {
  RAILCAR_PROGRAM_ID,
  checkDepartureIx,
  configPda,
  decodeCarAccount,
  decodeConfig,
  decodeTable,
  finalizeIx,
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

const ROOT = join(process.cwd(), "..");
const SO_DIR = process.env.RAILCAR_SO_DIR ?? join(ROOT, "target/deploy");
const BUILT = existsSync(join(SO_DIR, "tesoro_core.so")) && existsSync(join(SO_DIR, "railcar.so"));

const CORE = new PublicKey((coreIdl as { address: string }).address);
const UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const ALT_PROGRAM = new PublicKey("AddressLookupTab1e1111111111111111111111111");
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
const [ANA, BEN, CY, DEE, EVE] = [0, 1, 2, 3, 4];

/** The LiteSVM world: tesoro_core and Railcar as the Rust ride tests set them up, plus who signed what. */
class World {
  // Imported lazily so the suite only needs the native module where the programs are built.
  svm!: import("litesvm").LiteSVM;
  Clock!: typeof import("litesvm").Clock;
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
    const { LiteSVM, Clock } = await import("litesvm");
    w.Clock = Clock;
    w.svm = new LiteSVM().withSigverify(false);
    w.svm.addProgramWithLoader(CORE, readFileSync(join(SO_DIR, "tesoro_core.so")), UPGRADEABLE);
    w.svm.addProgramWithLoader(RAILCAR_PROGRAM_ID, readFileSync(join(SO_DIR, "railcar.so")), UPGRADEABLE);
    const noop = readFileSync(join(__dirname, "test-programs/noop.so"));
    for (const id of [MAGIC, PERMISSION_PROGRAM_ID, VRF]) w.svm.addProgram(id, noop);
    for (const k of [w.admin, w.oracle, w.ctl, w.operator, w.relayer, w.pageKey]) w.svm.airdrop(k.publicKey, 1_000n * SOL);
    w.setTime(T0);
    await w.setUp();
    return w;
  }

  // ---- sending ------------------------------------------------------------------------------------------------------

  send(ixs: TransactionInstruction[], payer: Keypair, signers: Keypair[] = [], tables: AddressLookupTableAccount[] = []): void {
    process.stderr.write(`SEND ${ixs.map((i) => i.programId.toBase58().slice(0, 4) + ":" + Buffer.from(i.data.subarray(0, 2)).toString("hex")).join(",")}\n`);
    this.svm.expireBlockhash();
    const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: this.svm.latestBlockhash(), instructions: ixs }).compileToV0Message(tables);
    const tx = new VersionedTransaction(msg);
    const all = [payer, ...signers];
    tx.sign(all.filter((k, i) => all.findIndex((x) => x.publicKey.equals(k.publicKey)) === i && msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).some((s) => s.equals(k.publicKey))));
    for (const r of this.riders) if (msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).some((s) => s.equals(r.key))) this.walletSigs[this.phase] = (this.walletSigs[this.phase] ?? 0) + 1;
    process.stderr.write(`  size ${tx.serialize().length} accounts ${msg.staticAccountKeys.length}\n`);
    const res = this.svm.sendTransaction(tx);
    process.stderr.write(`  sent\n`);
    const meta = "meta" in res ? (res as { meta(): { logs(): string[] } }).meta() : (res as { logs(): string[] });
    this.lastLogs = meta.logs();
    if ("err" in res) throw new Error(`transaction failed: ${JSON.stringify((res as { err(): unknown }).err())}\n${this.lastLogs.join("\n")}`);
  }

  /** A lookup table holding every non-signer account of `ixs`, written in place (the server compiles with its own). */
  table(ixs: TransactionInstruction[]): AddressLookupTableAccount {
    const keys = [...new Map(ixs.flatMap((i) => [i.programId, ...i.keys.filter((k) => !k.isSigner).map((k) => k.pubkey)]).map((k) => [k.toBase58(), k])).values()];
    const key = Keypair.generate().publicKey;
    const head = Buffer.alloc(56);
    head.writeUInt32LE(1, 0);
    head.writeBigUInt64LE(0xffff_ffff_ffff_ffffn, 4);
    this.svm.setAccount(key, { lamports: Number(10n * SOL), data: Buffer.concat([head, ...keys.map((k) => k.toBuffer())]), owner: ALT_PROGRAM, executable: false });
    return new AddressLookupTableAccount({ key, state: { deactivationSlot: 0xffff_ffff_ffff_ffffn, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: keys } });
  }

  fits(payer: PublicKey, ixs: TransactionInstruction[]): boolean {
    const t = this.table(ixs);
    try {
      const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: PublicKey.default.toBase58(), instructions: ixs }).compileToV0Message([t]);
      const accounts = msg.staticAccountKeys.length + msg.addressTableLookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0);
      return new VersionedTransaction(msg).serialize().length <= MAX_TX_BYTES && accounts <= MAX_ACCOUNTS;
    } catch {
      return false;
    }
  }

  setClock(slot: bigint, ts: number) {
    this.slot = slot;
    this.now = ts;
    this.svm.setClock(new this.Clock(slot, 0n, 0n, 0n, BigInt(ts)));
  }
  setTime(t: number) {
    this.setClock(SLOT0 + BigInt(Math.max(0, t - T0)) * SPS, t);
  }
  setSlot(slot: bigint) {
    this.setClock(slot, T0 + Number((slot - SLOT0) / SPS));
  }

  info(k: PublicKey): AccountInfo<Buffer> | null {
    const a = this.svm.getAccount(k);
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
    this.svm.setAccount(treasury, { lamports: Number(SOL), data: tdata, owner: CORE, executable: false });
    const pool = corePda("leaderboard");
    this.send([coreIx("init_leaderboard", { admin: admin.publicKey, config: corePda("config"), pool_authority: pool, pool_account: corePda("account", pool.toBuffer()), treasury }, { leaderboard_bps: 100 })], admin);
    // The control key is Railcar's upgrade authority; core approves the build's hash.
    const pd = programData(RAILCAR_PROGRAM_ID);
    const acct = this.svm.getAccount(pd)!;
    const data = Buffer.from(acct.data);
    data[12] = 1;
    this.ctl.publicKey.toBuffer().copy(data, 13);
    let end = data.length;
    while (end > 45 && data[end - 1] === 0) end--;
    const hash = createHash("sha256").update(data.subarray(45, end)).digest();
    this.svm.setAccount(pd, { ...acct, data });
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
      this.svm.setAccount(vault, { lamports: Number(SOL), data: blank, owner: RAILCAR_PROGRAM_ID, executable: false });
      const t = this.svm.getAccount(table)!;
      const td = Buffer.from(t.data);
      td[8 + 15] = 1;
      this.svm.setAccount(table, { ...t, data: td });
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
    const s = decodeStore(this.svm.getAccount(spillPda(p.account))!.data);
    let need = free - (s.capacity - s.len - s.roomReserved);
    while (need > 0) {
      const n = Math.min(need, 71);
      this.send([coreIx("grow_store", { payer: p.key, account: p.account, basket: basketPda(p.account), spill: spillPda(p.account) }, { which: { Spill: {} }, extra_lines: n })], p.kp);
      need -= n;
    }
  }

  /** Playable Gemas (every line of basket and spill). */
  gemas(p: Person): bigint {
    return [basketPda(p.account), spillPda(p.account)].reduce((sum, k) => sum + decodeStore(this.svm.getAccount(k)!.data).lines().reduce((a, l) => a + l.amount, 0n), 0n);
  }
  studioFee(): bigint {
    return [basketPda(this.studio.account), spillPda(this.studio.account)].reduce((sum, k) => sum + decodeStore(this.svm.getAccount(k)!.data).lines().filter((l) => l.cls === CLASS_STUDIO).reduce((a, l) => a + l.amount, 0n), 0n);
  }

  // ---- the app's steps -------------------------------------------------------------------------------------------------

  /** The Queue as the page boards: read the config and the boarding car, choose, and send the wallet's one transaction. */
  async board(p: Person): Promise<void> {
    const conn = this.reader();
    const config = decodeConfig(this.info(configPda())!.data);
    let boarding = null;
    if (config.nextCar > 0n) {
      const carNo = config.nextCar - 1n;
      const car = decodeCarAccount(this.info(carPda(carNo))!.data);
      const loaded = await loadCar(conn, car.tesoroMatch);
      if (loaded) boarding = { car: loaded.car, carNo, pages: loaded.pages };
    }
    const choice = queueChoice({ config, boarding, now: this.now, mine: false });
    const stores = await readEntryStores(p.account, conn);
    const preview = previewEntry(stores, 500n);
    expect(preview.needsTicket).toBe(false);
    const pot = freshPot(p.account, preview.potLines, await readNextTicket(p.account, conn));
    const remaining = await drawRemaining(preview.plan, conn);
    const ixs: TransactionInstruction[] = [cu(1_000_000)];
    if (choice.kind === "join") {
      ixs.push(joinSeatIx({ payer: p.key, player: p.key, car: choice.car, game: RAILCAR_PROGRAM_ID, page: choice.page, pot, remaining }), checkDepartureIx(choice.carNo, choice.car));
    } else if (choice.kind === "open") {
      const n = nextMatchOf(this.info(countersPda(p.account))?.data);
      const match = matchPda(p.account, n);
      ixs.push(openCarIx({ payer: p.key, opener: p.key, config, n }), joinSeatIx({ payer: p.key, player: p.key, car: match, game: RAILCAR_PROGRAM_ID, page: 0, pot, remaining }), checkDepartureIx(choice.carNo, match));
    } else throw new Error(`unexpected Queue choice ${choice.kind}`);
    this.send(ixs, p.kp);
  }

  rideSlot(index: number): bigint {
    return decodeTable(this.svm.getAccount(tablePda(index))!.data).rideSlot;
  }

  /** Ends with a commit stand-in when the step ended the ride: base keeps the Table's bytes. */
  rollup(ixs: TransactionInstruction[], signer: Keypair, index: number) {
    this.send(ixs, signer);
    const data = this.svm.getAccount(tablePda(index))!.data;
    const t = decodeTable(data);
    if (t.phase === "over" && data[8 + 16] === 0) this.committed.set(tablePda(index).toBase58(), Buffer.from(data));
  }

  /** Base's view of the Table (the committed bytes, owned by the delegation program) while `f` runs. */
  onBase<T>(index: number, f: () => T): T {
    const key = tablePda(index);
    const live = this.svm.getAccount(key)!;
    this.svm.setAccount(key, { lamports: live.lamports, data: this.committed.get(key.toBase58())!, owner: DELEGATION_PROGRAM_ID, executable: false });
    try {
      return f();
    } finally {
      this.svm.setAccount(key, live);
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

describe.skipIf(!BUILT)("a Railcar ride in LiteSVM, sent with the app's builders and the shared planner", () => {
  it("the worked example pays to the Gema: boarding, departure, the ride, finalize, every chunk and close", { timeout: 120_000 }, async () => {
    const w = await World.create();
    w.riders = Array.from({ length: 5 }, () => w.rider());
    const riders = w.riders;

    // Boarding: the first opens the car, the others join it, each in one wallet transaction.
    w.phase = "boarding";
    for (const p of riders) await w.board(p);
    const config = decodeConfig(w.info(configPda())!.data);
    const carNo = config.nextCar - 1n;
    const carAcct = decodeCarAccount(w.info(carPda(carNo))!.data);
    const match = carAcct.tesoroMatch;
    const before = riders.map((p) => w.gemas(p));
    const studioBefore = w.studioFee();

    // Departure 30 s after the 5th boarded: anyone's check_departure, the relayer paying.
    w.phase = "finish";
    w.setTime(w.now + 30);
    w.send([checkDepartureIx(carNo, match)], w.relayer);
    expect((await loadCar(w.reader(), match))!.car.stage).toBe("departed");

    // The ride: a page starts it, the VRF answers, Players Jump, a signal at Impact ends it.
    const loaded = (await loadCar(w.reader(), match))!;
    w.rollup([cu(1_400_000), startRideIx(w.pageKey.publicKey, { carNo, table: carAcct.table, tesoroMatch: match }, loaded.car.pages, null)], w.pageKey, carAcct.table);
    const table = tablePda(carAcct.table);
    const draw = drawWhere((r) => r.crash_ms >= 101_000);
    const reqNonce = Buffer.from(w.svm.getAccount(table)!.data).readBigUInt64LE(8 + 120);
    const request = PublicKey.findProgramAddressSync([Buffer.from("vrfreq"), table.toBuffer(), u64(reqNonce)], RAILCAR_PROGRAM_ID)[0];
    const identity = PublicKey.findProgramAddressSync([Buffer.from("identity"), RAILCAR_PROGRAM_ID.toBuffer()], VRF)[0];
    w.send([railcarIx("draw_callback", { vrf_program_identity: identity, table, vault: vaultPda(table), request }, { randomness: Array.from(draw) })], w.oracle);
    expect(decodeTable(w.svm.getAccount(table)!.data).phase).toBe("riding");

    w.phase = "jumps";
    const rideSlot = w.rideSlot(carAcct.table);
    for (const [who, secs] of [
      [ANA, 25],
      [CY, 95],
      [BEN, 97],
      [DEE, 99],
    ] as const) {
      w.setSlot(rideSlot + BigInt(secs) * SPS);
      const t = decodeTable(w.svm.getAccount(table)!.data);
      const seat = t.seats.find((s) => s.account.equals(riders[who].account))!;
      // The wallet signs the Jump until Railcar takes the seat key (seat keys ticket 08).
      w.rollup([jumpIx(riders[who].key, riders[who].key, carAcct.table, carNo, seat.tableSeat)], riders[who].kp, carAcct.table);
    }
    w.phase = "finish";
    const vault = new BorshAccountsCoder(railcarIdl as unknown as Idl).decode("Vault", Buffer.from(w.svm.getAccount(vaultPda(table))!.data)) as { crash_ms: number };
    w.setSlot(rideSlot + BigInt(Math.ceil(vault.crash_ms / 10)));
    w.rollup([signalIx(w.pageKey.publicKey, carAcct.table)], w.pageKey, carAcct.table);
    const over = decodeTable(w.svm.getAccount(table)!.data);
    expect([over.phase, over.outcome, over.aboard, over.jumps]).toEqual(["over", "placed", 1, 4]);

    // Finalize on base (the committed Table), the relayer as caller, compiled with a lookup table.
    const fin = [cu(1_400_000), finalizeIx(w.relayer.publicKey, { ...carAcct, carNo }, loaded.car.pages)];
    w.onBase(carAcct.table, () => w.send(fin, w.relayer, [], [w.table(fin)]));
    expect(w.info(carPda(carNo))).toBeNull();

    // Room, then every chunk the planner sizes, until core has paid the car.
    const core = new Program(coreIdl as Idl, { connection: {} } as unknown as AnchorProvider);
    let car = (await loadCar(w.reader(), match))!;
    expect(car.car.stage).toBe("settling");
    const room = await roomIxs(w.reader(), w.relayer.publicKey, car);
    if (room.length) w.send(room, w.relayer);
    let chunks = 0;
    const sizes: number[] = [];
    while (car.car.stage === "settling" || car.car.stage === "refunding") {
      const plan = await planSeatChunk(core, w.reader(), w.relayer.publicKey, car, (ix) => w.fits(w.relayer.publicKey, [cu(1_400_000), ix]));
      expect(plan).not.toBeNull();
      expect(plan!.missing).toEqual([]);
      const ixs = [cu(1_400_000), plan!.ix];
      w.send(ixs, w.relayer, [], [w.table(ixs)]);
      sizes.push(plan!.steps);
      chunks++;
      expect(chunks).toBeLessThan(50);
      car = (await loadCar(w.reader(), match))!;
    }
    expect(car.car.stage).toBe("paid");
    // 11 steps in all (4 entries home, Ana's 150 cut three ways then to Dee, Eve's 500 to Dee, Ben, Cy).
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(11);

    // Every seat closes, then the car.
    for (const ix of await closeIxs(w.reader(), w.relayer.publicKey, car)) w.send([cu(400_000), ix], w.relayer, [], [w.table([ix])]);
    expect(w.info(match)).toBeNull();

    // What each got back for the 500 they boarded with.
    expect(riders.map((p, i) => w.gemas(p) - before[i])).toEqual([350n, 630n, 578n, 813n, 0n]);
    expect(w.studioFee() - studioBefore).toBe(64n);
    // The wallets signed boarding (5) and the Jumps (4, until the seat key plays them); nothing of the finish.
    expect(w.walletSigs).toEqual({ boarding: 5, jumps: 4 });
  });
});
