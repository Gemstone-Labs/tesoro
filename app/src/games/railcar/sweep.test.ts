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
    const scanning = { ...reader(base), carByMatch: async (m: PublicKey) => (scans++, m.equals(match) ? { carNo: 7n, info: await car(7n, match) } : null) };
    const ride = await findCarRide(scanning, reader(rollup), match);
    expect([ride?.carNo, scans]).toEqual([7n, 1]);
  });
});

describe("the sweep reconciles each Table's next car on its own", () => {
  it("skips a car whose core Match is gone or frozen and closes its Car, and leaves a car still boarding or riding alone", async () => {
    const base = new Map<string, Info>();
    const rollup = new Map<string, Info>();
    const refunded = key();
    const boarding = key();
    base.set(configPda().toBase58(), await config(6n, boarding));
    // Table 0 waits for car 2, refunded and closed by a page that never sent skip_car; its Car is still open
    base.set(carPda(2n).toBase58(), await car(2n, refunded));
    base.set(settledPda(refunded).toBase58(), owned(Buffer.alloc(123), new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh")));
    rollup.set(tablePda(0).toBase58(), table(0, { phase: "over", carNo: 0n, nextCar: 2n, tesoroMatch: key() }));
    // Table 1 waits for car 5, still boarding
    base.set(carPda(5n).toBase58(), await car(5n, boarding));
    base.set(boarding.toBase58(), owned(Buffer.alloc(840), new PublicKey("AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh")));
    rollup.set(tablePda(1).toBase58(), table(1, { phase: "idle", carNo: 3n, nextCar: 5n }));
    const sent: string[] = [];
    const e = env(reader(base), reader(rollup), PublicKey.default, sent);
    expect(await reconcileTables(e)).toEqual({ skipped: [2n] });
    expect(sent).toEqual(["skip_car", "close_car"]);
    // a Table whose next car is not opened yet, and one whose car's Car account is already closed: skip only
    sent.length = 0;
    base.delete(carPda(2n).toBase58());
    rollup.set(tablePda(1).toBase58(), table(1, { phase: "idle", carNo: 3n, nextCar: 7n }));
    expect(await reconcileTables(e)).toEqual({ skipped: [2n] });
    expect(sent).toEqual(["skip_car"]);
  });
});
