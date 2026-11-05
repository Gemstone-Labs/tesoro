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

/** One event-CPI inner instruction as `program` emits it, under `authority` (its own event authority by default). */
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
  backer?: PublicKey;
  share?: number;
  order?: number;
  jumpMs?: number;
  refund?: bigint;
}
interface Run {
  draw: Uint8Array;
  kind?: number;
  places?: { seat: number; won: bigint }[];
  fees?: bigint[];
  outcome?: number;
  reason?: number;
  brakes?: { seat: number; ms: number }[];
}

const funder = (r: Rider) => r.backer ?? r.who;

/** `reveal_ride`'s transaction: Railcar's RideRevealed. */
const reveal = (n: number, riders: Rider[], o: Run): InnerInstruction[] => [
  cpi(RAILCAR, "RideRevealed", {
    opener: OPENER,
    n: BigInt(n),
    car_no: BigInt(n),
    tesoro_match: MATCH(n),
    outcome: o.outcome ?? 1,
    reason: o.reason ?? 1,
    draw: Array.from(o.draw),
    brakes: o.brakes ?? [],
    seats: riders.map((r, i) => ({ seat: i, order: r.order ?? 0, jump_ms: r.jumpMs ?? 0, refund: r.refund ?? 0n, player: r.who, backer: r.backer ?? null, share_bps: r.share ?? 0 })),
  }),
];

/** `finalize`'s (or core's refund's) transaction: MatchWon (a win), ManySeatRunStarted, ManySeatPlaced. */
function start(n: number, riders: Rider[], o: Run): InnerInstruction[] {
  const kind = o.kind ?? 0;
  const places = o.places ?? [];
  const fees = o.fees ?? [0n, 0n, 0n];
  const out: InnerInstruction[] = [];
  if (kind === 0) {
    const first = riders[places[0].seat];
    out.push(cpi(CORE, "MatchWon", { opener: OPENER, n: BigInt(n), game: RAILCAR, entry: 500n, player: first.who, funder: funder(first), points: 5n, pool_fee: fees[2], season: 7, ts: BigInt(T0 + 400), loser: riders[places[1]?.seat ?? 0].who, challenge: false, asset: 0, opened_at: BigInt(T0) }));
  }
  out.push(
    cpi(CORE, "ManySeatRunStarted", { match_state: MATCH(n), opener: OPENER, n: BigInt(n), game: RAILCAR, kind, entry: 500n, seated: riders.length, places: places.length, fees, fees_capped: false, refunded: 0n, forfeited: 0n, ts: BigInt(T0 + 400) }),
    ...places.map((p, k) => cpi(CORE, "ManySeatPlaced", { match_state: MATCH(n), opener: OPENER, n: BigInt(n), place: k + 1, seat: p.seat, player: riders[p.seat].who, funder: funder(riders[p.seat]), share_bps: riders[p.seat].share ?? 0, won: p.won })),
  );
  return out;
}

/** A chunk of the payout: each seat's entry line going home to its funder (purpose 3), then the run's end. */
const seatLine = (seat: number, to: PublicKey, purpose = 3) => ({ pot_side: seat, pot_index_le: [0, 0, 0, 0], purpose, incoming: new Array(144).fill(0), outgoing: new Array(144).fill(0), recipient_kind: 0, recipient: Array.from(to.toBytes()), placement: 0 });
const paid = (n: number, riders: Rider[], kind: number, homeLines = false): InnerInstruction[] => {
  // one line per chunk here (the test's encoder holds 1,000 bytes; a line is 328)
  const lines = homeLines ? riders.map((r, i) => [seatLine(i, funder(r))]) : [[]];
  return [
    ...lines.map((l, k) => cpi(CORE, "ManySeatChunkDone", { opener: OPENER, n: BigInt(n), chunk_no: k + 1, first_step: k + 1, steps: l.length, done: k === lines.length - 1, blocked: false, overflowed: 0, lines: l })),
    cpi(CORE, "ManySeatSettled", { match_state: MATCH(n), opener: OPENER, n: BigInt(n), kind, chunks: lines.length }),
  ];
};

const gameOf = () => null;
async function ingest(rpc: Rpc, txs: InnerInstruction[][]) {
  for (const inner of txs) await ingestMatchRecords(rpc, decodeMatchRecords(inner), { gameOf, signature: "sig", slot: 1 });
}
const rowsOf = async (rpc: Rpc, who: PublicKey) => (await accountHistory(rpc, who.toBase58(), 1, 50)).rows;
const rowIn = async (rpc: Rpc, who: PublicKey, n: number) => (await rowsOf(rpc, who)).filter((r) => r.id.endsWith(`-${n}`));

// The spec's worked example: Ana off at 25 s (350 back), Cy, Ben, Dee off at 95-99 s, Eve aboard. Fees 129.
const workedRiders = (): Rider[] => [
  { who: ANA, order: 1, jumpMs: 25_000, refund: 350n },
  { who: BEN, order: 3, jumpMs: 97_000 },
  { who: CY, order: 2, jumpMs: 95_000 },
  { who: DEE, order: 4, jumpMs: 99_000 },
  { who: EVE },
];
const workedRun = (draw: Uint8Array): Run => ({ draw, places: [{ seat: 3, won: 313n }, { seat: 1, won: 130n }, { seat: 2, won: 78n }], fees: [44n, 64n, 21n] });

describe("Railcar rides in the Match history, from the reveal, the run's start and its chunks", () => {
  let rpc: Rpc;
  const draw = drawFrom(104_000);

  beforeAll(async () => {
    ({ rpc } = await testDb());
    const riders = workedRiders();
    await ingest(rpc, [reveal(1, riders, workedRun(draw)), start(1, riders, workedRun(draw)), paid(1, riders, 0)]);
  }, 120_000);

  it("every Player of the worked example has the ride in their history, with what it gave or cost them", async () => {
    const row = async (who: PublicKey) => {
      const [r] = await rowIn(rpc, who, 1);
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
    const r = replayRide(rideRecordOf(page!)!);
    expect(r.agrees).toBe(true);
    expect(r.crashMs).toBe(ride(draw).crashMs);
    expect(r.seats.map((s) => s.gets)).toEqual([350n, 630n, 578n, 813n, 0n]);
  });

  it("the win card is the last Player off, with the ride; the Lobby's recent wins pay entry and first place", async () => {
    const card = await winCard(rpc, { opener: OPENER.toBase58(), n: 1n });
    expect(card).toMatchObject({ game: "railcar", entry: 500, winner: DEE.toBase58(), gemas: 313 });
    expect(rideRecordOf(card!)!.seats).toHaveLength(5);
    const [w] = await recentWins(rpc, { game: "railcar", limit: 5 });
    expect([w.winner, w.payout]).toEqual([DEE.toBase58(), 813]);
  });

  it("the pieces land in any order and any number of times: the same rows", async () => {
    const riders = workedRiders();
    const txs = [paid(2, riders, 0), start(2, riders, workedRun(draw)), reveal(2, riders, workedRun(draw))];
    await ingest(rpc, txs);
    // before the ride's reveal arrives in a third copy, nothing changes; repeats change nothing
    await ingest(rpc, [...txs, ...txs]);
    for (const who of [ANA, BEN, CY, DEE, EVE]) {
      const [a] = await rowIn(rpc, who, 1);
      const [b] = await rowIn(rpc, who, 2);
      expect([b.result, b.delta, b.ride]).toEqual([a.result, a.delta, a.ride]);
    }
  });

  it("a win whose ride is not revealed yet names nobody, then everyone once it is", async () => {
    const riders = workedRiders();
    await ingest(rpc, [start(3, riders, workedRun(draw))]);
    expect(await rowIn(rpc, DEE, 3)).toEqual([]);
    await ingest(rpc, [paid(3, riders, 0), reveal(3, riders, workedRun(draw))]);
    expect((await rowIn(rpc, DEE, 3)).map((r) => r.delta)).toEqual([313]);
  });

  it("a backed seat: the Backer's row takes the entry's fate, the Player keeps their Offer share of the winnings", async () => {
    // Ben rides on Bob's Gemas at a 40% share and places second (130 won); in another ride Bob's Player Eve is aboard.
    const placed = workedRiders();
    placed[1] = { ...placed[1], backer: BOB, share: 4_000 };
    await ingest(rpc, [reveal(4, placed, workedRun(draw)), start(4, placed, workedRun(draw)), paid(4, placed, 0)]);
    const aboard = workedRiders();
    aboard[4] = { ...aboard[4], backer: BOB, share: 4_000 };
    await ingest(rpc, [start(5, aboard, workedRun(draw)), reveal(5, aboard, workedRun(draw)), paid(5, aboard, 0)]);
    const bob = await rowsOf(rpc, BOB);
    expect(bob.map((r) => [r.id.split("-").pop(), r.role, r.result, r.delta, r.backing])).toEqual([
      ["5", "backer", "lost", -500, { other: EVE.toBase58(), shareBps: 4_000 }],
      ["4", "backer", "won", 78, { other: BEN.toBase58(), shareBps: 4_000 }],
    ]);
    const [ben] = await rowIn(rpc, BEN, 4);
    expect([ben.result, ben.delta, ben.backerDelta]).toEqual(["won", 52, 78]);
    const [eve] = await rowIn(rpc, EVE, 5);
    expect([eve.result, eve.delta, eve.backerDelta]).toEqual(["lost", 0, -500]);
  });

  it("nobody jumped: every entry back, Refunded, for every Player and Backer", async () => {
    const riders = [ANA, BEN, CY, DEE, EVE].map((who) => ({ who }) as Rider);
    riders[2] = { who: CY, backer: BOB, share: 5_000 };
    const run: Run = { draw, kind: 6, outcome: 2, reason: 2 };
    await ingest(rpc, [reveal(6, riders, run), start(6, riders, run), paid(6, riders, 6, true)]);
    const [cy] = await rowIn(rpc, CY, 6);
    expect([cy.result, cy.delta, cy.ride]).toEqual(["refunded", 0, { seated: 5, kind: "refund" }]);
    const [bob] = await rowIn(rpc, BOB, 6);
    expect([bob.role, bob.result, bob.delta]).toEqual(["backer", "refunded", 0]);
  });

  it("core refunds a car nobody revealed (24 h after departure): whoever paid each entry sees it Refunded", async () => {
    const riders = [ANA, BEN, CY, DEE, EVE].map((who) => ({ who }) as Rider);
    riders[4] = { who: EVE, backer: BOB, share: 5_000 };
    const run: Run = { draw, kind: 4 };
    await ingest(rpc, [paid(7, riders, 4, true), start(7, riders, run)]);
    for (const who of [ANA, BEN, CY, DEE, BOB]) {
      const rows = await rowIn(rpc, who, 7);
      expect(rows.map((r) => [r.game, r.result, r.delta, r.ride])).toEqual([["railcar", "refunded", 0, { seated: 5, kind: "refund" }]]);
    }
    // core's refund lines name who paid, not a backed seat's Player
    expect(await rowIn(rpc, EVE, 7)).toEqual([]);
  });

  it("a RideRevealed that Railcar did not emit names nobody; one Railcar emitted that does not decode stops the cursor", () => {
    const [ix] = reveal(8, workedRiders(), workedRun(draw));
    expect(decodeMatchRecords([{ ...ix, accounts: [key(99).toBase58()] }])).toEqual([]);
    expect(decodeMatchRecords([{ ...ix, programId: key(98).toBase58() }])).toEqual([]);
    const broken = { ...ix, data: Buffer.concat([Buffer.from(ix.data).subarray(0, 16), Buffer.from([1, 2, 3])]) };
    expect(() => decodeMatchRecords([broken])).toThrow(/cursor must wait/);
  });
});
