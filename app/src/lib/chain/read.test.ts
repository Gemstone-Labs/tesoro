import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import coreIdl from "./idl/tesoro_core.json";
import { matchPda } from "./basket";
import { canJoinSeat, chainMatchFromPage, toChainMatch } from "./read";
import type { MatchPage } from "@/server/history/reads";

// The same construction as the app client, so field names come out as the app reads them (camelCase).
const coder = new Program(coreIdl as unknown as Idl, new AnchorProvider(new Connection("http://localhost:8899"), {} as never, {})).coder.accounts;
const key = () => Keypair.generate().publicKey;
const arr = (k: PublicKey) => Array.from(k.toBytes());
const HOLDEM = "CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE";

/** A MatchState as Anchor decodes it (camelCase), built from the IDL's snake_case through the real coder. */
function state(over: { stage?: object; run?: unknown; challenge?: boolean; asset?: number; a?: { player: PublicKey; funder: PublicKey; bps?: number }; b?: { player: PublicKey; funder: PublicKey } | null }) {
  const opener = over.a?.player ?? key();
  const party = (p: { player: PublicKey; funder: PublicKey; bps?: number }) => ({ player: arr(p.player), funder: arr(p.funder), shareBps: p.bps ?? 0 });
  const inner = {
    id: { opener: arr(opener), n: new BN(5) },
    meta: { challenge: over.challenge ?? false, asset: over.asset ?? 0, listed: true },
    game: arr(new PublicKey(HOLDEM)),
    settleAuthority: arr(key()),
    deploySlot: new BN(1),
    terms: { platformBps: 200, studioBps: 300, studioOwner: null, studioPriority: true },
    entry: new BN(500),
    openedAt: new BN(1_791_200_000),
    deadline: new BN(1_791_203_600),
    deadlineAbs: new BN(1_791_800_000),
    a: party(over.a ?? { player: opener, funder: opener }),
    b: over.b ? party(over.b) : null,
    potLines: [1, 1],
    stage: over.stage ?? { open: {} },
    run: over.run ?? null,
  };
  return coder.encode("matchState", { bump: 255, inner, listed: true, listingEpoch: 0, payer: key(), pots: [key(), key()], room: Array.from({ length: 5 }, () => ({ account: arr(PublicKey.default), left: 0 })) }).then((buf) => coder.decode("matchState", buf));
}

describe("toChainMatch (a MatchState of the economy upgrade)", () => {
  it("names the Match by opener and counter and reads Challenge, asset, opening time and Fees from its own fields", async () => {
    const opener = key();
    const s = await state({ a: { player: opener, funder: opener }, challenge: true, asset: 2 });
    const m = toChainMatch(s, opener, null);
    expect(m.id).toBe(`${opener.toBase58()}-5`);
    expect(m.opener).toBe(opener.toBase58());
    expect(m.n).toBe(5n);
    expect(m.address.equals(matchPda(opener, 5n))).toBe(true);
    expect(m).toMatchObject({ game: "holdem", status: "open", running: null, seat: 0, entry: 500, challenge: true, asset: 2, openedAt: 1_791_200_000_000, deadline: 1_791_203_600 });
    expect(m.fees).toMatchObject({ platformBps: 200, studioBps: 300 });
  });

  it("maps the stage: Settling and Refunding are still active, Closed is settled or refunded by how the run ended", async () => {
    const a = key();
    const b = key();
    const sides = { a: { player: a, funder: a }, b: { player: b, funder: b } };
    const run = (kind: string) => ({ kind: { [kind[0].toLowerCase() + kind.slice(1)]: {} }, receipt: { id: { opener: arr(a), n: new BN(5) }, kind: { [kind[0].toLowerCase() + kind.slice(1)]: {} }, at: new BN(1) }, fees: [0, 0, 0].map((n) => new BN(n)), phases: Array.from({ length: 4 }, () => ({ cuts: {} })), nPhases: 0, phaseI: 0, lineI: 0, cutLeft: [[0, 0, 0], [0, 0, 0]].map((r) => r.map((n) => new BN(n))), playerLeft: new BN(0), chunks: 0, steps: 0 });
    const read = async (stage: string, kind?: string) => toChainMatch(await state({ ...sides, stage: { [stage[0].toLowerCase() + stage.slice(1)]: {} }, run: kind ? run(kind) : null }), a, null);
    expect(await read("Active")).toMatchObject({ status: "active", running: null });
    expect(await read("Settling", "Win")).toMatchObject({ status: "active", running: "settling" });
    expect(await read("Refunding", "Draw")).toMatchObject({ status: "active", running: "refunding" });
    expect(await read("Closed", "Win")).toMatchObject({ status: "settled" });
    expect(await read("Closed", "Draw")).toMatchObject({ status: "settled" });
    expect(await read("Closed", "NoShow")).toMatchObject({ status: "refunded" });
    expect(await read("Closed", "ByGame")).toMatchObject({ status: "refunded" });
  });

  it("sees a Backer's seat and share", async () => {
    const player = key();
    const backer = key();
    const opp = key();
    const s = await state({ a: { player, funder: backer, bps: 3000 }, b: { player: opp, funder: opp } });
    const asBacker = toChainMatch(s, backer, null);
    expect(asBacker.seat).toBeNull();
    expect(asBacker.backerSeat).toBe(0);
    expect(asBacker.backing).toEqual({ seat: 0, player: player.toBase58(), funder: backer.toBase58(), shareBps: 3000 });
    expect(toChainMatch(s, player, null).backing?.shareBps).toBe(3000);
    expect(toChainMatch(s, opp, null).backing).toBeNull();
  });
});

describe("canJoinSeat (tesoro_core: a Backer never joins the Player they back, nobody joins their own Match)", () => {
  const player = key();
  const backer = key();
  const seat = (p: PublicKey, f: PublicKey) => ({ player: arr(p), funder: arr(f) });
  it("refuses the Player, the funder and allows anyone else", () => {
    expect(canJoinSeat(seat(player, backer), player)).toBe(false);
    expect(canJoinSeat(seat(player, backer), backer)).toBe(false);
    expect(canJoinSeat(seat(player, backer), key())).toBe(true);
    expect(canJoinSeat(seat(player, player), key())).toBe(true);
  });
});

describe("a closed Match from the history", () => {
  const a = key();
  const b = key();
  const page: MatchPage = {
    id: `${a.toBase58()}-9`,
    game: "block-puzzle",
    entry: 500,
    status: "settled",
    kind: 0,
    challenge: false,
    asset: 0,
    openedAt: 1_791_200_000_000,
    settledAt: 1_791_200_900_000,
    sides: [{ player: a.toBase58(), funder: a.toBase58() }, { player: b.toBase58(), funder: b.toBase58() }],
    winnerSide: 1,
    winner: b.toBase58(),
    loser: a.toBase58(),
    points: 5,
    season: 3,
    fees: { platform: 20, studio: 30, leaderboard: 10 },
    chunks: 2,
    scores: [200, 410],
    parties: [],
  };
  it("reads as a settled ChainMatch with its winner and scores", () => {
    const m = chainMatchFromPage(page, b)!;
    expect(m).toMatchObject({ id: page.id, status: "settled", seat: 1, winner: "joiner", openedAt: 1_791_200_000_000 });
    expect(m.session).toMatchObject({ settled: true, result: "joiner", scores: [200, 410] });
    expect(m.address.equals(matchPda(a, 9n))).toBe(true);
  });
  it("is null for a Game this app does not play", () => {
    expect(chainMatchFromPage({ ...page, game: "chess" }, null)).toBeNull();
  });
});

describe("who won, from tesoro_core's own record", () => {
  it("reads the winning side of a Closed win; a draw, a refund or a missing side names nobody", async () => {
    const a = key();
    const b = key();
    const sides = { a: { player: a, funder: a }, b: { player: b, funder: b } };
    const run = (kind: object) => ({ kind, receipt: { id: { opener: arr(a), n: new BN(5) }, kind, at: new BN(1) }, fees: [0, 0, 0].map((n) => new BN(n)), phases: Array.from({ length: 4 }, () => ({ cuts: {} })), nPhases: 0, phaseI: 0, lineI: 0, cutLeft: [[0, 0, 0], [0, 0, 0]].map((r) => r.map((n) => new BN(n))), playerLeft: new BN(0), chunks: 0, steps: 0 });
    const read = async (kind: object) => toChainMatch(await state({ ...sides, stage: { closed: {} }, run: run(kind) }), a, null);
    expect((await read({ win: { winner: 0 } })).winner).toBe("opener");
    expect((await read({ win: { winner: 1 } })).winner).toBe("joiner");
    expect((await read({ draw: {} })).winner).toBeNull();
    expect((await read({ noShow: {} })).winner).toBeNull();
  });
});
