import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import type { TableView } from "../../app/src/games/railcar/chain.ts";
import type { RideStep } from "../../app/src/games/railcar/flow.ts";
import type { CarView } from "../../app/src/lib/chain/many-seat.ts";
import { COMMIT_RETRY_SECS, RIDE_CAP_SECS, sweepRideAction } from "./railcar-sweep.ts";

const T0 = 1_800_000_000;
const car = (over: Partial<CarView> = {}) => ({ address: Keypair.generate().publicKey, stage: "departed", departedAt: T0 - 900, refundAfter: T0 + 86_400, ...over }) as CarView;
const table = (over: Partial<TableView> = {}) => ({ phase: "riding", rideTs: T0 - 300, dirty: false, commitAt: 0, ...over }) as TableView;
const act = (kind: RideStep["kind"], o: { core?: Partial<CarView>; rollup?: TableView | null; now?: number } = {}) =>
  sweepRideAction({ kind, ...(kind === "finalize-previous" ? { carNo: 3n } : {}) } as RideStep, { core: car(o.core), rollup: o.rollup === undefined ? table() : o.rollup, now: o.now ?? T0 });

describe("the sweep's step for a Railcar ride whose pages are gone", () => {
  it("sends what a page would: the departure, the ride's start, and the finish (reveal, then finalize) once base holds the ride", () => {
    assert.deepEqual(act("depart", { core: { stage: "boarding", deadlineAbs: T0 + 7 * 86_400 } }), { send: "depart" });
    assert.deepEqual(act("start-ride"), { send: "start-ride" });
    assert.deepEqual(act("finalize"), { send: "finish" });
  });

  it("signals a ride still inside its cap only as a look (not a try), and as a step once the cap is over", () => {
    assert.deepEqual(act("signal", { rollup: table({ rideTs: T0 - 60 }) }), { send: "signal", untilOver: true });
    assert.deepEqual(act("signal", { rollup: table({ rideTs: T0 - RIDE_CAP_SECS }) }), { send: "signal", untilOver: false });
    assert.deepEqual(act("signal", { rollup: table({ phase: "drawing" }) }), { send: "signal", untilOver: true });
  });

  it("commits again only when the result is owed or the last commit may be lost", () => {
    assert.deepEqual(act("commit", { rollup: table({ phase: "over", dirty: true }) }), { send: "commit" });
    assert.deepEqual(act("commit", { rollup: table({ phase: "over", commitAt: T0 - 10 }) }), { wait: "the commit is on its way to base" });
    assert.deepEqual(act("commit", { rollup: table({ phase: "over", commitAt: T0 - COMMIT_RETRY_SECS }) }), { send: "commit" });
  });

  it("finishes through core's refund from 24 h after departure, whatever the ride's step (finalize too: a ride that never revealed must not wait forever)", () => {
    const late = { now: T0 + 86_400, core: { refundAfter: T0 + 86_400 } };
    for (const kind of ["signal", "start-ride", "commit", "wait", "finalize-previous", "finalize", "refund"] as const) assert.deepEqual(act(kind, late), { send: "finish" }, kind);
    // a page's own refund step (the car's refund time came) is the same finish
    assert.deepEqual(act("refund", { core: { refundAfter: T0 } }), { send: "finish" });
  });

  it("steps every seat off a car still Boarding once core's boarding has ended (an hour before its deadline), whatever the count", () => {
    const deadlineAbs = T0 + 3_600;
    assert.deepEqual(act("wait", { core: { stage: "boarding", deadlineAbs }, now: T0 - 1 }), { wait: "nothing a page would send yet" });
    assert.deepEqual(act("wait", { core: { stage: "boarding", deadlineAbs } }), { send: "step-off" });
    assert.deepEqual(act("depart", { core: { stage: "boarding", deadlineAbs } }), { send: "step-off" });
  });

  it("leaves the Table's previous car, and the finisher's steps, to their own turn", () => {
    assert.ok("wait" in act("finalize-previous"));
    assert.ok("wait" in act("wait"));
    assert.ok("wait" in act("settle", { core: { stage: "settling" } }));
  });
});

describe("the keeper's Railcar reader", () => {
  it("finds a car's Car through one program scan on the scan RPC, never by reading car numbers in batches (rideProgress, the ride step)", async () => {
    const { BN, BorshAccountsCoder } = await import("@coral-xyz/anchor");
    const { readFileSync } = await import("node:fs");
    const { PublicKey } = await import("@solana/web3.js");
    const { carPda, configPda, tablePda } = await import("../../app/src/games/railcar/chain.ts");
    const { rideProgress } = await import("./railcar-sweep.ts");
    const idl = JSON.parse(readFileSync(new URL("../../app/src/lib/chain/idl/railcar.json", import.meta.url), "utf8"));
    const coder = new BorshAccountsCoder(idl);
    const match = Keypair.generate().publicKey;
    const accounts = new Map<string, Buffer>();
    accounts.set(configPda().toBase58(), await coder.encode("RailcarConfig", { bump: 255, operator: PublicKey.default, tables: 2, next_car: new BN(300), boarding_match: PublicKey.default }));
    const carData = await coder.encode("Car", { bump: 255, car_no: new BN(0), tesoro_match: match, table: 0, tables: 2, opened_at: new BN(1), payer: PublicKey.default, revealed: false });
    accounts.set(carPda(0n).toBase58(), carData);
    for (const i of [0, 1]) {
      const t = Buffer.alloc(8 + 308 + 100 * 88);
      t.writeUInt16LE(i, 8 + 2);
      t[8 + 4] = 2;
      t.writeBigUInt64LE(BigInt(298 + i), 8 + 24);
      t.writeBigUInt64LE(BigInt(300 + i), 8 + 32);
      accounts.set(tablePda(i).toBase58(), t);
    }
    const batches: number[] = [];
    const info = (k: PublicKey) => {
      const d = accounts.get(k.toBase58());
      return d ? { data: d, owner: new PublicKey(idl.address), lamports: 1, executable: false } : null;
    };
    const conn = { getMultipleAccountsInfo: async (keys: PublicKey[]) => (batches.push(keys.length), keys.map(info)), getAccountInfo: async (k: PublicKey) => info(k) };
    let scans = 0;
    const rpc = { helius: false, call: async () => ({}), getProgramAccounts: async () => (scans++, [{ pubkey: carPda(0n), account: { data: carData, lamports: 1, owner: new PublicKey(idl.address), executable: false } }]) };
    const ctx = { conn, burst: { teeConnection: async () => conn }, hsigner: {} } as unknown as Parameters<typeof rideProgress>[0];
    assert.equal(await rideProgress(ctx, match, rpc), "0:298:riding:0:298:riding");
    assert.equal(scans, 1);
    assert.ok(batches.every((n) => n <= 2), `batches ${batches.join(",")}`);
  });
});
