import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import railcarIdl from "@/lib/chain/idl/railcar.json";
import { ride } from "@/games/railcar/engine";
import { replayRide } from "@/games/railcar/replay";
import { rideRecordOf } from "@/lib/chain/ride-history";
import { decodeMatchRecords, type InnerInstruction } from "./events";
import { ingestMatchRecords } from "./ingest";
import { accountHistory, matchPage, recentWins, winCard } from "./reads";
import { testDb } from "./test-db";
import type { Rpc } from "./rpc";

// A fresh in-process Postgres takes several seconds to start when the machine is busy.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const CORE = new PublicKey((coreIdl as { address: string }).address);
const RAILCAR = new PublicKey((railcarIdl as { address: string }).address);
const authorityOf = (program: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], program)[0];
const TAG = Buffer.from("e445a52e51cb9a1d", "hex");
const coders = new Map<string, BorshCoder>([
  [CORE.toBase58(), new BorshCoder(coreIdl as Idl)],
  [RAILCAR.toBase58(), new BorshCoder(railcarIdl as Idl)],
]);
const idls = new Map<string, Idl>([
  [CORE.toBase58(), coreIdl as Idl],
  [RAILCAR.toBase58(), railcarIdl as Idl],
]);

/** One event-CPI inner instruction as `program` emits it, signed by `authority` (its own event authority by default). */
function cpi(program: PublicKey, name: string, body: Record<string, unknown>, authority = authorityOf(program), as = program): InnerInstruction {
  const wire = (v: unknown): unknown => (typeof v === "bigint" ? new BN(v.toString()) : Array.isArray(v) ? v.map(wire) : v && typeof v === "object" && !(v instanceof PublicKey) && !(v instanceof Uint8Array) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, wire(x)])) : v);
  const bytes = coders.get(program.toBase58())!.types.encode(name, wire(body));
  const disc = Buffer.from((idls.get(program.toBase58()) as any).events.find((e: any) => e.name === name).discriminator);
  return { programId: as.toBase58(), accounts: [authority.toBase58()], data: Buffer.concat([TAG, disc, bytes]) };
}

const key = (seed: number) => new PublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? seed : (seed * 13 + i) % 251)));
const [ANA, BEN, CY, DEE, EVE, BOB] = [11, 12, 13, 14, 15, 16].map(key);
const OPENER = ANA;
const T0 = 1_762_000_000;
const MATCH = (n: number) => PublicKey.findProgramAddressSync([Buffer.from("match"), OPENER.toBuffer(), new BN(n).toArrayLike(Buffer, "le", 8)], CORE)[0];

/** A draw whose wall stands at or after `minMs`. */
function drawFrom(minMs: number): Uint8Array {
  for (let i = 1; i < 10_000; i++) {
    const d = Uint8Array.from({ length: 32 }, (_, k) => (i * 31 + k * 7) % 256);
    if (ride(d).crashMs >= minMs) return d;
  }
  throw new Error("no draw");
}

interface Rider {
  who: PublicKey;
  funder?: PublicKey;
  share?: number;
  order?: number;
  jumpMs?: number;
  refund?: bigint;
}

/**
 * The events of one Railcar `finalize` (core's MatchWon, ManySeatRunStarted, ManySeatPlaced, then Railcar's RideSettled),
 * then the chunks and ManySeatSettled of the payout.
 */
function rideEvents(n: number, riders: Rider[], o: { draw: Uint8Array; kind?: number; places?: { seat: number; won: bigint }[]; fees?: bigint[]; refunded?: bigint; forfeited?: bigint; outcome?: number; reason?: number; brakes?: { seat: number; ms: number }[] }): InnerInstruction[][] {
  const match = MATCH(n);
  const kind = o.kind ?? 0;
  const places = o.places ?? [];
  const fees = o.fees ?? [0n, 0n, 0n];
  const funder = (r: Rider) => r.funder ?? r.who;
  const finalize: InnerInstruction[] = [];
  if (kind === 0) {
    const first = riders[places[0].seat];
    const second = riders[places[1]?.seat ?? 0];
    finalize.push(cpi(CORE, "MatchWon", { opener: OPENER, n: BigInt(n), game: RAILCAR, entry: 500n, player: first.who, funder: funder(first), points: 5n, pool_fee: fees[2], season: 7, ts: BigInt(T0 + 400), loser: second.who, challenge: false, asset: 0, opened_at: BigInt(T0) }));
  }
  finalize.push(
    cpi(CORE, "ManySeatRunStarted", { match_state: match, opener: OPENER, n: BigInt(n), game: RAILCAR, kind, entry: 500n, seated: riders.length, places: places.length, fees, fees_capped: false, refunded: o.refunded ?? 0n, forfeited: o.forfeited ?? 0n, ts: BigInt(T0 + 400) }),
    ...places.map((p, k) => cpi(CORE, "ManySeatPlaced", { match_state: match, opener: OPENER, n: BigInt(n), place: k + 1, seat: p.seat, player: riders[p.seat].who, funder: funder(riders[p.seat]), share_bps: riders[p.seat].share ?? 0, won: p.won })),
    cpi(RAILCAR, "RideSettled", {
      car_no: BigInt(n),
      tesoro_match: match,
      outcome: o.outcome ?? 1,
      reason: o.reason ?? 1,
      draw: Array.from(o.draw),
      brakes: o.brakes ?? [],
      seats: riders.map((r, i) => ({ seat: i, order: r.order ?? 0, jump_ms: r.jumpMs ?? 0, refund: r.refund ?? 0n, player: r.who, funder: funder(r), share_bps: r.share ?? 0 })),
    }),
  );
  const paid = [cpi(CORE, "ManySeatChunkDone", { opener: OPENER, n: BigInt(n), chunk_no: 1, first_step: 1, steps: 0, done: true, blocked: false, overflowed: 0, lines: [] }), cpi(CORE, "ManySeatSettled", { match_state: match, opener: OPENER, n: BigInt(n), kind, chunks: 1 })];
  return [finalize, paid];
}

const gameOf = () => null;
async function ingest(rpc: Rpc, txs: InnerInstruction[][]) {
  for (const inner of txs) await ingestMatchRecords(rpc, decodeMatchRecords(inner), { gameOf, signature: "sig", slot: 1 });
}
const rowOf = async (rpc: Rpc, who: PublicKey) => (await accountHistory(rpc, who.toBase58(), 1)).rows;

// The spec's worked example: Ana off at 25 s (350 back), Cy, Ben, Dee off at 95-99 s, Eve aboard. Fees 129.
const worked = (draw: Uint8Array): [Rider[], Parameters<typeof rideEvents>[2]] => [
  [
    { who: ANA, order: 1, jumpMs: 25_000, refund: 350n },
    { who: BEN, order: 3, jumpMs: 97_000 },
    { who: CY, order: 2, jumpMs: 95_000 },
    { who: DEE, order: 4, jumpMs: 99_000 },
    { who: EVE },
  ],
  { draw, places: [{ seat: 3, won: 313n }, { seat: 1, won: 130n }, { seat: 2, won: 78n }], fees: [44n, 64n, 21n], refunded: 350n, forfeited: 650n },
];

describe("Railcar rides in the Match history", () => {
  let rpc: Rpc;
  const draw = drawFrom(104_000);

  beforeAll(async () => {
    ({ rpc } = await testDb());
    const [riders, o] = worked(draw);
    await ingest(rpc, rideEvents(1, riders, o));
  }, 120_000);

  it("every Player of the worked example has the ride in their history, with what it gave or cost them", async () => {
    const row = async (who: PublicKey) => {
      const [r] = await rowOf(rpc, who);
      return [r.game, r.result, r.delta, r.ride];
    };
    expect(await row(DEE)).toEqual(["railcar", "won", 313, { seated: 5, kind: "place", place: 1, jumpMs: 99_000 }]);
    expect(await row(BEN)).toEqual(["railcar", "won", 130, { seated: 5, kind: "place", place: 2, jumpMs: 97_000 }]);
    expect(await row(CY)).toEqual(["railcar", "won", 78, { seated: 5, kind: "place", place: 3, jumpMs: 95_000 }]);
    expect(await row(ANA)).toEqual(["railcar", "lost", -150, { seated: 5, kind: "early", jumpMs: 25_000 }]);
    expect(await row(EVE)).toEqual(["railcar", "lost", -500, { seated: 5, kind: "aboard" }]);
  });

  it("the ride's page replays from the record and agrees with what the chain paid", async () => {
    const page = await matchPage(rpc, { opener: OPENER.toBase58(), n: 1n });
    const rec = rideRecordOf(page!)!;
    const r = replayRide(rec);
    expect(r.agrees).toBe(true);
    expect(r.crashMs).toBe(ride(draw).crashMs);
    expect(r.seats.map((s) => s.gets)).toEqual([350n, 630n, 578n, 813n, 0n]);
  });

  it("the win card is the last Player off, with the ride", async () => {
    const card = await winCard(rpc, { opener: OPENER.toBase58(), n: 1n });
    expect(card).toMatchObject({ game: "railcar", entry: 500, winner: DEE.toBase58(), gemas: 313 });
    expect(rideRecordOf(card!)!.seats).toHaveLength(5);
  });

  it("the Lobby's recent wins pay the last Player off their entry and first place", async () => {
    const [w] = await recentWins(rpc, { game: "railcar", limit: 5 });
    expect([w.winner, w.payout]).toEqual([DEE.toBase58(), 813]);
  });

  it("a backed seat: the Backer's row takes the entry's fate, the Player keeps their Offer share of the winnings", async () => {
    // Ben rides on Bob's Gemas at a 40% share and places second (130 won); in a second ride Bob's Player Eve is aboard.
    const [riders, o] = worked(draw);
    riders[1] = { ...riders[1], funder: BOB, share: 4_000 };
    await ingest(rpc, rideEvents(2, riders, o));
    const aboard = worked(draw)[0].map((r, i) => (i === 4 ? { ...r, funder: BOB, share: 4_000 } : r));
    await ingest(rpc, rideEvents(3, aboard, worked(draw)[1]));
    const bob = await rowOf(rpc, BOB);
    expect(bob.map((r) => [r.id.endsWith("-2"), r.role, r.result, r.delta, r.backing])).toEqual([
      [false, "backer", "lost", -500, { other: EVE.toBase58(), shareBps: 4_000 }],
      [true, "backer", "won", 78, { other: BEN.toBase58(), shareBps: 4_000 }],
    ]);
    const ben = (await rowOf(rpc, BEN)).find((r) => r.id.endsWith("-2"))!;
    expect([ben.result, ben.delta, ben.backerDelta]).toEqual(["won", 52, 78]);
    const eve = (await rowOf(rpc, EVE)).find((r) => r.id.endsWith("-3"))!;
    expect([eve.result, eve.delta, eve.backerDelta]).toEqual(["lost", 0, -500]);
  });

  it("nobody jumped: every entry back, refunded, no fees", async () => {
    const riders = [ANA, BEN, CY, DEE, EVE].map((who) => ({ who }));
    await ingest(rpc, rideEvents(4, riders, { draw, kind: 6, outcome: 2, reason: 2 }));
    const row = (await rowOf(rpc, CY)).find((r) => r.id.endsWith("-4"))!;
    expect([row.result, row.delta, row.ride]).toEqual(["refunded", 0, { seated: 5, kind: "refund" }]);
  });

  it("a RideSettled that Railcar did not emit names nobody", () => {
    const [riders, o] = worked(draw);
    const [finalize] = rideEvents(5, riders, o);
    const forged = finalize.map((ix) => (ix.programId === RAILCAR.toBase58() ? { ...ix, accounts: [key(99).toBase58()] } : ix));
    const start = decodeMatchRecords(forged).find((r) => r.type === "seats-start");
    expect(start && start.type === "seats-start" ? start.ride : "missing").toBeNull();
    const elsewhere = finalize.map((ix) => (ix.programId === RAILCAR.toBase58() ? { ...ix, programId: key(98).toBase58() } : ix));
    const other = decodeMatchRecords(elsewhere).find((r) => r.type === "seats-start");
    expect(other && other.type === "seats-start" ? other.ride : "missing").toBeNull();
  });
});
