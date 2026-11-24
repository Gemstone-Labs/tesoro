import { BN, BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import railcarIdl from "@/lib/chain/idl/railcar.json";
import { settledPda } from "../../lib/chain/basket";
import type { Info, Reader } from "../../lib/chain/settle-plan";
import { carPda, configPda, tablePda } from "./chain";
import { findCarRide, finishCar, reconcileTables, type SweepEnv, type SweepSend } from "./sweep";

const coder = new BorshAccountsCoder(railcarIdl as unknown as Idl);
const key = () => Keypair.generate().publicKey;
const owned = (data: Buffer, owner = new PublicKey(railcarIdl.address)): Info => ({ data, owner, lamports: 1, executable: false } as unknown as Info);

async function config(nextCar: bigint, boardingMatch = PublicKey.default): Promise<Info> {
  return owned(await coder.encode("RailcarConfig", { bump: 255, operator: key(), tables: 2, next_car: new BN(nextCar.toString()), boarding_match: boardingMatch }));
}
async function car(carNo: bigint, tesoroMatch: PublicKey, payer = key()): Promise<Info> {
  return owned(await coder.encode("Car", { bump: 255, car_no: new BN(carNo.toString()), tesoro_match: tesoroMatch, table: Number(carNo % 2n), tables: 2, opened_at: new BN(1), payer, revealed: false }));
}
/** A Table's bytes as the rollup holds them (zero-copy): the fields the decoder reads. */
function table(index: number, o: { phase: "idle" | "drawing" | "riding" | "over"; carNo: bigint; nextCar: bigint; tesoroMatch?: PublicKey }): Info {
  const d = Buffer.alloc(8 + 308 + 100 * 88);
  const b = 8;
  d.writeUInt16LE(index, b + 2);
  d[b + 4] = ["idle", "drawing", "riding", "over"].indexOf(o.phase);
  d.writeBigUInt64LE(o.carNo, b + 24);
  d.writeBigUInt64LE(o.nextCar, b + 32);
  (o.tesoroMatch ?? PublicKey.default).toBuffer().copy(d, b + 72);
  return owned(d, new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"));
}
const reader = (accounts: Map<string, Info>): Reader => ({ many: async (keys) => keys.map((k) => accounts.get(k.toBase58()) ?? null) });
const env = (base: Reader, rollup: Reader, match: PublicKey, sent: string[], landed: (what: string) => void = () => {}): SweepEnv => ({
  base,
  rollup,
  core: {} as SweepEnv["core"],
  caller: key(),
  match,
  now: 1_800_000_000,
  fits: () => true,
  send: async (s: SweepSend) => {
    sent.push(s.what.split(" ")[0]);
    landed(s.what);
  },
});

describe("the sweep finds a car whose Table has moved on", () => {
  it("looks the Car up by its Match among every car opened, not only the recent ones, and closes it", async () => {
    const match = key();
    const payer = key();
    const base = new Map<string, Info>();
    const rollup = new Map<string, Info>();
    // 150 cars opened; car 0's Table rides car 148 now; car 0's Match is gone (the sweep closed it) but its Car is still open
    base.set(configPda().toBase58(), await config(150n));
    base.set(carPda(0n).toBase58(), await car(0n, match, payer));
    for (const no of [148n, 149n]) base.set(carPda(no).toBase58(), await car(no, key()));
    rollup.set(tablePda(0).toBase58(), table(0, { phase: "riding", carNo: 148n, nextCar: 150n, tesoroMatch: key() }));
    rollup.set(tablePda(1).toBase58(), table(1, { phase: "riding", carNo: 149n, nextCar: 151n, tesoroMatch: key() }));
    const ride = await findCarRide(reader(base), reader(rollup), match);
    expect(ride).toMatchObject({ carNo: 0n, table: 0, car: { payer } });
    const sent: string[] = [];
    await finishCar(env(reader(base), reader(rollup), match, sent, (what) => what === "close-ride" && base.delete(carPda(0n).toBase58())), null);
    expect(sent).toEqual(["close-ride"]);
    expect(base.has(carPda(0n).toBase58())).toBe(false);
  });

  it("prefers a reader that can look a Car up by its Match (the keeper's program scan)", async () => {
    const match = key();
    const base = new Map<string, Info>();
    base.set(configPda().toBase58(), await config(5_000n));
    const rollup = new Map<string, Info>();
    rollup.set(tablePda(0).toBase58(), table(0, { phase: "idle", carNo: 4_998n, nextCar: 5_000n }));
    rollup.set(tablePda(1).toBase58(), table(1, { phase: "idle", carNo: 4_999n, nextCar: 5_001n }));
    let scans = 0;
    const scanning = { ...reader(base), carByMatch: async (m: PublicKey) => (scans++, m.equals(match) ? { carNo: 7n, data: (await car(7n, match))!.data } : null) };
    const ride = await findCarRide(scanning, reader(rollup), match);
    expect([ride?.carNo, scans]).toEqual([7n, 1]);
  });
});

describe("the sweep reconciles the Cars and each Table's next car on its own", () => {
  const CORE = new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh");
  async function chain() {
    const base = new Map<string, Info>();
    const rollup = new Map<string, Info>();
    const refunded = key();
    const boarding = key();
    base.set(configPda().toBase58(), await config(6n, boarding));
    // Table 0 waits for car 2, refunded and closed by a page that never sent skip_car; its Car is still open
    base.set(carPda(2n).toBase58(), await car(2n, refunded));
    rollup.set(tablePda(0).toBase58(), table(0, { phase: "over", carNo: 0n, nextCar: 2n, tesoroMatch: key() }));
    // Table 1 waits for car 5, still boarding; car 4 (Table 0's car after car 2) left and waits for its Table
    base.set(carPda(5n).toBase58(), await car(5n, boarding));
    base.set(boarding.toBase58(), owned(Buffer.alloc(840), CORE));
    const waiting = key();
    base.set(carPda(4n).toBase58(), await car(4n, waiting));
    base.set(waiting.toBase58(), owned(Buffer.alloc(840), CORE));
    rollup.set(tablePda(1).toBase58(), table(1, { phase: "idle", carNo: 3n, nextCar: 5n }));
    return { base, rollup, refunded, boarding };
  }
  /** Sends land on the fake chain: a close removes the Car, a skip moves the Table on; `failing` steps throw instead. */
  const landing = (base: Map<string, Info>, rollup: Map<string, Info>, sent: string[], failing: string[] = []) =>
    env(reader(base), reader(rollup), PublicKey.default, sent, (what) => {
      const [step, no] = what.split(" ");
      if (failing.includes(step)) throw new Error(`${step} failed`);
      if (step === "close_car") base.delete(carPda(BigInt(no)).toBase58());
      if (step === "skip_car") {
        const i = Number(BigInt(no) % 2n);
        const t = rollup.get(tablePda(i).toBase58())!;
        Buffer.from(t.data.buffer, t.data.byteOffset).writeBigUInt64LE(BigInt(no) + 2n, 8 + 32);
      }
    });

  it("closes the Car of a car core refunded or closed before it rode, then passes it over; a car still boarding and an unopened next car are left alone", async () => {
    const { base, rollup } = await chain();
    const sent: string[] = [];
    expect(await reconcileTables(landing(base, rollup, sent))).toEqual({ closed: [2n], skipped: [2n], failed: [] });
    expect(sent).toEqual(["close_car", "skip_car"]);
    expect(base.has(carPda(2n).toBase58())).toBe(false);
    sent.length = 0;
    expect(await reconcileTables(landing(base, rollup, sent))).toEqual({ closed: [], skipped: [], failed: [] });
    expect(sent).toEqual([]);
  });

  it("a close that fails leaves the Table waiting (no skip past an open Car); the next pass closes and then skips", async () => {
    const { base, rollup } = await chain();
    const sent: string[] = [];
    expect(await reconcileTables(landing(base, rollup, sent, ["close_car"]))).toEqual({ closed: [], skipped: [], failed: [2n] });
    expect(sent).toEqual(["close_car"]);
    expect(base.has(carPda(2n).toBase58())).toBe(true);
    sent.length = 0;
    expect(await reconcileTables(landing(base, rollup, sent))).toEqual({ closed: [2n], skipped: [2n], failed: [] });
    expect(sent).toEqual(["close_car", "skip_car"]);
  });

  it("a Table waiting for a car whose Car is already closed only moves on; an open Car of a car its Table already passed over only closes", async () => {
    const { base, rollup, refunded } = await chain();
    base.delete(carPda(2n).toBase58());
    // car 0: Table 0 moved past it long ago (its page sent skip_car); its Car is open and its Match has a receipt
    const gone = key();
    base.set(carPda(0n).toBase58(), await car(0n, gone));
    base.set(settledPda(gone).toBase58(), owned(Buffer.alloc(123), CORE));
    const sent: string[] = [];
    expect(await reconcileTables(landing(base, rollup, sent))).toEqual({ closed: [0n], skipped: [2n], failed: [] });
    expect(sent).toEqual(["skip_car", "close_car"]);
    expect(refunded).toBeDefined();
  });

  it("a Car the scan did not list yet (it lags base) is read by its address: still boarding, it is left alone; refunded, it is closed then skipped", async () => {
    const { base, rollup, refunded } = await chain();
    const stale = { ...reader(base), openCars: async () => [] as { carNo: bigint; data: Uint8Array }[] };
    const sent: string[] = [];
    // car 2 refunded (Match gone): the scan missed it, base has it
    expect(await reconcileTables({ ...landing(base, rollup, sent), base: stale })).toEqual({ closed: [2n], skipped: [2n], failed: [] });
    expect(sent).toEqual(["close_car", "skip_car"]);
    // car 4 is next on Table 0 now, departed and waiting (its Match live, no receipt): nothing, and never a skip past an open Car
    sent.length = 0;
    expect(await reconcileTables({ ...landing(base, rollup, sent), base: stale })).toEqual({ closed: [], skipped: [], failed: [] });
    expect(sent).toEqual([]);
    expect(refunded).toBeDefined();
  });

  it("one Table's failed skip goes to failed and the other Tables still run", async () => {
    const { base, rollup } = await chain();
    // Table 1 waits for car 3, whose Car is closed already (core froze it): skip only
    rollup.set(tablePda(1).toBase58(), table(1, { phase: "idle", carNo: 1n, nextCar: 3n }));
    const sent: string[] = [];
    expect(await reconcileTables(landing(base, rollup, sent, ["skip_car"]))).toEqual({ closed: [2n], skipped: [], failed: [2n, 3n] });
    expect(sent).toEqual(["close_car", "skip_car", "skip_car"]);
    sent.length = 0;
    expect(await reconcileTables(landing(base, rollup, sent))).toEqual({ closed: [], skipped: [2n, 3n], failed: [] });
    expect(sent).toEqual(["skip_car", "skip_car"]);
  });

  it("a read that throws after one Table's close (the readback) goes to failed for that car; the other Tables still run", async () => {
    const { base, rollup } = await chain();
    rollup.set(tablePda(1).toBase58(), table(1, { phase: "idle", carNo: 1n, nextCar: 3n }));
    const sent: string[] = [];
    const e = landing(base, rollup, sent);
    let closedOnce = false;
    const flaky = {
      many: async (keys: PublicKey[]) => {
        if (closedOnce && keys.length === 1 && keys[0].equals(carPda(2n))) {
          closedOnce = false;
          throw new Error("rpc down");
        }
        return reader(base).many(keys);
      },
    };
    const send = e.send;
    e.send = async (s) => {
      await send(s);
      if (s.what.startsWith("close_car 2")) closedOnce = true;
    };
    expect(await reconcileTables({ ...e, base: flaky })).toEqual({ closed: [], skipped: [3n], failed: [2n] });
    expect(sent).toEqual(["close_car", "skip_car"]);
    sent.length = 0;
    expect(await reconcileTables({ ...e, base: flaky })).toEqual({ closed: [], skipped: [2n], failed: [] });
    expect(sent).toEqual(["skip_car"]);
  });

  it("asks a reader that can list the open Cars (the keeper's program scan) instead of reading every car number", async () => {
    const { base, rollup } = await chain();
    base.set(configPda().toBase58(), await config(5_000n));
    let listed = 0;
    const reads: number[] = [];
    const plain = reader(base);
    const scanning = {
      many: async (keys: PublicKey[]) => (reads.push(keys.length), plain.many(keys)),
      openCars: async () => (listed++, [2n, 5n].map((no) => ({ carNo: no, data: base.get(carPda(no).toBase58())!.data }))),
    };
    const sent: string[] = [];
    const e = { ...landing(base, rollup, sent), base: scanning };
    expect(await reconcileTables(e)).toEqual({ closed: [2n], skipped: [2n], failed: [] });
    expect([listed, reads.some((n) => n > 10)]).toEqual([1, false]);
  });
});
