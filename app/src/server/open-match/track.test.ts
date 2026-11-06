import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import fixture from "../history/fixtures/helius-raw-devnet.json";
import type { RawTx } from "../history/webhook";
import { matchStateOf, trackTx } from "./track";
import { MemoryOpenMatchStore } from "./store";
import { coreIx, i64, key, matchRunStarted, rawTx, u64 } from "./test-tx";
import { BLOCK_PUZZLE_PROGRAM_ID } from "../../games/block-puzzle/chain";

const [START_V0] = fixture as unknown as RawTx[];
// The real devnet Block Burst Match 6qPLGMP5…-3: side A (opener, wins), side B (3Cyp…), entry 500.
const A = { account: "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ", authority: "authorityOfA" };
const B = { account: "3CypGMXD3iWa4DX9RTnuGH967GBSeL46NaM3CFU9NhJU", authority: "authorityOfB" };

describe("a Match that settled", () => {
  it("derives the Match account the way core does", () => {
    expect(START_V0.transaction.message.accountKeys).toContain(matchStateOf(A.account, 3n));
  });

  it("closes the Match in the table", async () => {
    const matches = new MemoryOpenMatchStore();
    const matchState = matchStateOf(A.account, 3n);
    await matches.open({ matchState, matchKey: `${A.account}-3`, game: "block-puzzle", entry: 500, opener: A });
    await matches.join(matchState, B, 1_793_243_774 + 3600);
    await trackTx(START_V0, matches);
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
    await trackTx(opened(7), matches);
    expect(await matches.get(matchStateOf(A.account, 7n))).toEqual({ matchState: matchStateOf(A.account, 7n), matchKey: `${A.account}-7`, game: "block-puzzle", entry: 500, players: [A], deadline: null });
    await trackTx(joined(7, 1_800_000_000), matches);
    expect(await matches.get(matchStateOf(A.account, 7n))).toMatchObject({ players: [A, B], deadline: 1_800_003_600 });
  });

  it("moves when a Game extends it, also when core runs inside the game's own instruction", async () => {
    const matches = new MemoryOpenMatchStore();
    await trackTx(opened(8), matches);
    await trackTx(joined(8, 1_800_000_000), matches);
    const extend = coreIx("extend_match_deadline", { match_state: matchStateOf(A.account, 8n) }, i64(1_800_086_400));
    await trackTx(rawTx("assign8", [{ program: key(9), accounts: [], data: Buffer.alloc(8), inner: [extend] }]), matches);
    expect((await matches.get(matchStateOf(A.account, 8n)))!.deadline).toBe(1_800_086_400);
  });

  it("is the same when a delivery repeats", async () => {
    const matches = new MemoryOpenMatchStore();
    for (const tx of [opened(9), joined(9, 1_800_000_000), opened(9), joined(9, 1_800_000_500)]) await trackTx(tx, matches);
    expect(await matches.get(matchStateOf(A.account, 9n))).toMatchObject({ players: [A, B], deadline: 1_800_003_600 });
  });

  it("ignores a Match of a Game the app does not play", async () => {
    const matches = new MemoryOpenMatchStore();
    await trackTx(opened(10, key(77)), matches);
    expect(matches.rows.size).toBe(0);
  });
});

describe("a Match that ended without a result", () => {
  const BP = BLOCK_PUZZLE_PROGRAM_ID.toBase58();
  const ended = (kind: number) => rawTx(`end${kind}`, [{ program: key(9), accounts: [], data: Buffer.alloc(8), inner: [matchRunStarted({ opener: A.account, n: 11, game: BP, kind, entry: 300, a: A.account, b: B.account })] }]);

  it.each([1, 3, 4, 5, 6])("kind %i closes the Match", async (kind) => {
    const matches = new MemoryOpenMatchStore();
    const matchState = matchStateOf(A.account, 11n);
    await matches.open({ matchState, matchKey: `${A.account}-11`, game: "block-puzzle", entry: 300, opener: A });
    await matches.join(matchState, B, 1_800_003_600);
    await trackTx(ended(kind), matches);
    expect(matches.rows.get(matchState)!.closed).toBe(true);
  });
});
