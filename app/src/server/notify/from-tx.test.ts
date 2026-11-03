import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import fixture from "../history/fixtures/helius-raw-devnet.json";
import type { RawTx } from "../history/webhook";
import { matchStateOf, processTx, type NotifyChain } from "./from-tx";
import { MemoryOpenMatchStore } from "./open-match";
import { CORE, coreIx, i64, key, matchRunStarted, rawTx, u64, yieldApplied } from "./test-tx";
import { BLOCK_PUZZLE_PROGRAM_ID } from "../../games/block-puzzle/chain";

const [START_V0] = fixture as unknown as RawTx[];
// The real devnet Block Burst Match 6qPLGMP5…-3: side A (opener, wins), side B (3Cyp…), entry 500, Fees 60.
const A = { account: "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ", authority: "authorityOfA" };
const B = { account: "3CypGMXD3iWa4DX9RTnuGH967GBSeL46NaM3CFU9NhJU", authority: "authorityOfB" };

const noChain: NotifyChain = { authorityOfAccount: async () => null, request: async () => null, offer: async () => null, position: async () => null };
const chainOf = (over: Partial<NotifyChain> = {}): NotifyChain => ({ ...noChain, ...over });

async function knownMatch(matches = new MemoryOpenMatchStore()) {
  const matchState = matchStateOf(A.account, 3n);
  await matches.open({ matchState, matchKey: `${A.account}-3`, game: "block-puzzle", entry: 500, opener: A });
  await matches.join(matchState, B, 1_793_243_774 + 3600);
  return { matches, matchState };
}

describe("a Match that settled", () => {
  it("tells each Player how it went, with the Gemas won or lost after Fees", async () => {
    const { matches } = await knownMatch();
    const events = await processTx(START_V0, { matches, chain: noChain }, { emails: true });
    expect(events).toEqual([
      { kind: "match-settled", id: `match-settled:${A.account}-3:authorityOfA`, authority: "authorityOfA", matchId: `${A.account}-3`, game: "block-puzzle", result: "won", gemas: 440, pot: 1000 },
      { kind: "match-settled", id: `match-settled:${A.account}-3:authorityOfB`, authority: "authorityOfB", matchId: `${A.account}-3`, game: "block-puzzle", result: "lost", gemas: 500, pot: 1000 },
    ]);
  });

  it("derives the Match account the way core does", () => {
    const keys = START_V0.transaction.message.accountKeys;
    expect(keys).toContain(matchStateOf(A.account, 3n));
  });

  it("asks the chain for a wallet the table does not know", async () => {
    const asked: string[] = [];
    const chain = chainOf({ authorityOfAccount: async (a) => (asked.push(a), a === A.account ? A.authority : null) });
    const events = await processTx(START_V0, { matches: new MemoryOpenMatchStore(), chain }, { emails: true });
    expect(asked.sort()).toEqual([A.account, B.account].sort());
    expect(events.map((e) => e.authority)).toEqual(["authorityOfA"]);
  });

  it("closes the Match in the table and sends nothing when email is off", async () => {
    const { matches, matchState } = await knownMatch();
    expect(await processTx(START_V0, { matches, chain: noChain }, { emails: false })).toEqual([]);
    expect(matches.rows.get(matchState)!.closed).toBe(true);
  });
});

const gameArg = (program: string) => new PublicKey(program).toBuffer();
const opened = (n: number, game = BLOCK_PUZZLE_PROGRAM_ID.toBase58()) =>
  rawTx(`open${n}`, [coreIx("open_match", { player_authority: A.authority, player_account: A.account, match_state: matchStateOf(A.account, BigInt(n)) }, Buffer.concat([gameArg(game), u64(500), u64(n)]))]);
const joined = (n: number, blockTime: number) =>
  rawTx(`join${n}`, [coreIx("join_match", { player_authority: B.authority, player_account: B.account, match_state: matchStateOf(A.account, BigInt(n)) })], { blockTime });

describe("a Match's refund deadline", () => {
  it("starts when the second Player joins: an hour after the join", async () => {
    const matches = new MemoryOpenMatchStore();
    const deps = { matches, chain: noChain };
    await processTx(opened(7), deps, { emails: false });
    expect(await matches.get(matchStateOf(A.account, 7n))).toEqual({ matchState: matchStateOf(A.account, 7n), matchKey: `${A.account}-7`, game: "block-puzzle", entry: 500, players: [A], deadline: null });
    await processTx(joined(7, 1_800_000_000), deps, { emails: false });
    expect(await matches.get(matchStateOf(A.account, 7n))).toMatchObject({ players: [A, B], deadline: 1_800_003_600 });
  });

  it("moves when a Game extends it, also when core runs inside the game's own instruction", async () => {
    const matches = new MemoryOpenMatchStore();
    const deps = { matches, chain: noChain };
    await processTx(opened(8), deps, { emails: false });
    await processTx(joined(8, 1_800_000_000), deps, { emails: false });
    const extend = coreIx("extend_match_deadline", { match_state: matchStateOf(A.account, 8n) }, i64(1_800_086_400));
    await processTx(rawTx("assign8", [{ program: key(9), accounts: [], data: Buffer.alloc(8), inner: [extend] }]), deps, { emails: false });
    expect((await matches.get(matchStateOf(A.account, 8n)))!.deadline).toBe(1_800_086_400);
  });

  it("is the same when a delivery repeats", async () => {
    const matches = new MemoryOpenMatchStore();
    const deps = { matches, chain: noChain };
    for (const tx of [opened(9), joined(9, 1_800_000_000), opened(9), joined(9, 1_800_000_500)]) await processTx(tx, deps, { emails: false });
    expect(await matches.get(matchStateOf(A.account, 9n))).toMatchObject({ players: [A, B], deadline: 1_800_003_600 });
  });

  it("ignores a Match of a Game the app does not play", async () => {
    const matches = new MemoryOpenMatchStore();
    await processTx(opened(10, key(77)), { matches, chain: noChain }, { emails: false });
    expect(matches.rows.size).toBe(0);
  });
});

describe("a Match that ended without a result", () => {
  const BP = BLOCK_PUZZLE_PROGRAM_ID.toBase58();
  const ended = (kind: number) => rawTx(`end${kind}`, [{ program: key(9), accounts: [], data: Buffer.alloc(8), inner: [matchRunStarted({ opener: A.account, n: 11, game: BP, kind, entry: 300, a: A.account, b: B.account })] }]);
  async function setup() {
    const matches = new MemoryOpenMatchStore();
    const matchState = matchStateOf(A.account, 11n);
    await matches.open({ matchState, matchKey: `${A.account}-11`, game: "block-puzzle", entry: 300, opener: A });
    await matches.join(matchState, B, 1_800_003_600);
    return { matches, matchState };
  }

  it.each([3, 4, 5, 6])("kind %i refunds both Players their entry", async (kind) => {
    const { matches } = await setup();
    const events = await processTx(ended(kind), { matches, chain: noChain }, { emails: true });
    expect(events).toEqual(["authorityOfA", "authorityOfB"].map((authority) => ({ kind: "match-refunded", id: `match-refunded:${A.account}-11:${authority}`, authority, matchId: `${A.account}-11`, game: "block-puzzle", entry: 300 })));
  });

  it("says nothing about a no-show, and closes the Match", async () => {
    const { matches, matchState } = await setup();
    expect(await processTx(ended(1), { matches, chain: noChain }, { emails: true })).toEqual([]);
    expect(matches.rows.get(matchState)!.closed).toBe(true);
  });

  it("tells a draw as a draw", async () => {
    const { matches } = await setup();
    const events = await processTx(ended(2), { matches, chain: noChain }, { emails: true });
    expect(events.map((e) => e.kind === "match-settled" && e.result)).toEqual(["draw", "draw"]);
  });
});

describe("Offers", () => {
  const request = key(31);
  const offer = key(32);
  const P = { account: key(41), authority: "authorityOfPlayer" };
  const chain = chainOf({
    authorityOfAccount: async (a) => (a === P.account ? P.authority : a === A.account ? A.authority : null),
    offer: async (a) => (a === offer ? { backer: A.account, request, game: "holdem", entry: 100 } : null),
    request: async (a) => (a === request ? { player: P.account, game: "holdem", entry: 100 } : null),
  });
  const matches = new MemoryOpenMatchStore();

  it("tells the Request's Player when a Backer makes an Offer", async () => {
    const tx = rawTx("offer1", [coreIx("create_offer", { backer_authority: A.authority, backer_account: A.account, request, offer })]);
    expect(await processTx(tx, { matches, chain }, { emails: true })).toEqual([{ kind: "offer-made", id: `offer-made:${offer}:authorityOfPlayer`, authority: "authorityOfPlayer", offerId: offer, game: "holdem", entry: 100 }]);
  });

  it("tells the Backer when the Player accepts", async () => {
    const tx = rawTx("accept1", [coreIx("accept_offer", { player_authority: P.authority, player_account: P.account, request, offer })]);
    expect(await processTx(tx, { matches, chain }, { emails: true })).toEqual([{ kind: "offer-accepted", id: `offer-accepted:${offer}:${A.authority}`, authority: A.authority, offerId: offer, game: "holdem", entry: 100 }]);
  });

  it("says nothing when the Offer cannot be read any more", async () => {
    const tx = rawTx("accept2", [coreIx("accept_offer", { player_account: P.account, request, offer: key(99) })]);
    expect(await processTx(tx, { matches, chain }, { emails: true })).toEqual([]);
  });

  it("reads nothing from the chain when email is off", async () => {
    const reads: string[] = [];
    const spy = chainOf({ offer: async (a) => (reads.push(a), null) });
    await processTx(rawTx("offer3", [coreIx("create_offer", { request, offer })]), { matches, chain: spy }, { emails: false });
    expect(reads).toEqual([]);
  });
});

describe("Debt cleared", () => {
  const position = key(51);
  const owner = key(52);
  const chain = chainOf({ authorityOfAccount: async (a) => (a === owner ? "authorityOfOwner" : null), position: async (a) => (a === position ? { owner, asset: "SOL" } : null) });
  const matches = new MemoryOpenMatchStore();
  const apply = (seq: number, debt: number, source = key(53)) => rawTx(`yield${seq}`, [coreIx("apply_yield", { position, source }, Buffer.alloc(0), [yieldApplied(position, seq, debt)])]);

  it("tells the owner when yield pays the last of an Advance", async () => {
    expect(await processTx(apply(7, 0), { matches, chain }, { emails: true })).toEqual([{ kind: "debt-cleared", id: `debt-cleared:${position}:7`, authority: "authorityOfOwner", positionId: position, asset: "SOL" }]);
  });

  it("says nothing while Debt is left", async () => {
    expect(await processTx(apply(8, 12), { matches, chain }, { emails: true })).toEqual([]);
  });

  it("says nothing for yield on a Position with no open Advance (no Source given)", async () => {
    expect(await processTx(apply(9, 0, CORE), { matches, chain }, { emails: true })).toEqual([]);
  });

  it("also reads yield applied from a Source's own chain", async () => {
    const tx = rawTx("yield10", [coreIx("apply_yield_from_source", { position, source: key(53) }, Buffer.alloc(0), [yieldApplied(position, 10, 0)])]);
    expect((await processTx(tx, { matches, chain }, { emails: true })).map((e) => e.kind)).toEqual(["debt-cleared"]);
  });
});
