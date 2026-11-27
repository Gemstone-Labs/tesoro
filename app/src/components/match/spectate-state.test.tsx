import { Keypair } from "@solana/web3.js";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chainMatchFromPage, outcomeOfKind, toChainMatch, type ChainMatch, type ClosedOutcome } from "@/lib/chain/read";
import { setLeaderboardSince } from "@/lib/chain/season";
import type { MatchPage } from "@/server/history/reads";
import { SpectateView } from "./MatchSpectate";
import { keepsReading, laterRead, readSpectated, spectateFee, spectateHeadline, spectateState, stateOf, winSeatOf, type Spectated } from "./spectate-state";
import qa from "./fixtures/qa-untabled-refund-match.json";

/**
 * The Seeker QA Match of 2026-11-26 (7k1s…BmN3-26): Block Burst, 100 Gemas each, both Players in, no table assigned. The fixture
 * is its tesoro_core account as read while the phone said "In play": stage Refunding, refunded by its Game 300 s after the join.
 */
type Qa = typeof qa;
// The Leaderboard Fee has been charged since Season 1 (fetchMatch reads this before any Match).
setLeaderboardSince(1_791_158_400);
const JOINED_AT = 1_795_741_718;
const during = (over: Partial<Qa["inner"]> | Record<string, unknown>): ChainMatch => toChainMatch({ ...qa, inner: { ...qa.inner, ...over } }, null, null);
const run = (kind: object, fees: [number, number, number] = [0, 0, 0]) => ({ ...qa.inner.run, kind, fees: fees.map(String) });

const waiting = during({ stage: { active: {} }, run: null });
const refunding = during({});
const refunded = during({ stage: { closed: {} } });
const winning = during({ stage: { settling: {} }, run: run({ win: { winner: 1 } }, [4, 6, 2]) });
const won = during({ stage: { closed: {} }, run: run({ win: { winner: 1 } }, [4, 6, 2]) });
const open = during({ stage: { open: {} }, run: null, b: null });

const view = (m: ChainMatch, tabled = false, at = (JOINED_AT + 60) * 1000) => renderToStaticMarkup(<SpectateView seen={{ m, tabled, at }} />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("what a spectator's Match page says, from the Match's stage and its table", () => {
  it("is Refunding, not In play, on the account the Seeker read after RefundUntabled", () => {
    expect(refunding).toMatchObject({ game: "block-puzzle", entry: 100, status: "active", running: "refunding" });
    expect(spectateState(refunding, false)).toBe("refunding");
    const page = text(view(refunding));
    expect(page).toContain("Refunding");
    expect(page).not.toContain("In play");
    expect(page).toContain("Both entries are on their way back");
  });

  it("maps every stage: waiting for an opponent, waiting for a table, in play, refunding, refunded, won", () => {
    expect(spectateState(open, false)).toBe("open");
    expect(spectateState(waiting, false)).toBe("table");
    expect(spectateState(waiting, true)).toBe("live");
    expect(spectateState(refunding, false)).toBe("refunding");
    expect(spectateState(refunding, true)).toBe("refunding");
    expect(spectateState(refunded, false)).toBe("refunded");
    expect(spectateState(winning, true)).toBe("settling");
    expect(spectateState(won, true)).toBe("settled");

    expect(spectateHeadline("open", null)).toBe("Waiting for an opponent");
    expect(spectateHeadline("table", null)).toBe("Waiting for a table");
    expect(spectateHeadline("live", null)).toBe("In play");
    expect(spectateHeadline("refunding", null)).toBe("Refunding");
    expect(spectateHeadline("refunded", null)).toBe("Refunded");
    expect(spectateHeadline("settling", "Ana")).toBe("Ana won");
    expect(spectateHeadline("settled", "Ana")).toBe("Ana won");
    expect(spectateHeadline("settled", null)).toBe("Draw");
  });

  it("says Waiting for a table until the Game assigns one, then In play", () => {
    const before = text(view(waiting, false));
    expect(before).toContain("Waiting for a table");
    expect(before).not.toContain("In play");
    expect(before).toMatch(/If none opens by .+, both entries come back\./);
    const late = text(view(waiting, false, (JOINED_AT + 301) * 1000));
    expect(late).toContain("Waiting for a table");
    expect(late).toContain("No table opened in time. Both entries are on their way back.");
    const after = text(view(waiting, true));
    expect(after).toContain("In play");
    expect(after).not.toContain("Waiting for a table");
    expect(after).toContain("Runs stay hidden until it settles.");
  });

  it("a Match nobody joined that is cancelling is Refunding with nothing charged", () => {
    const cancelling = during({ b: null, run: run({ cancelled: {} }) });
    expect(spectateState(cancelling, false)).toBe("refunding");
    expect(spectateFee(cancelling, "refunding")).toEqual({ label: "Fee charged", fee: 0 });
    expect(text(view(cancelling))).toContain("Nobody joined. The entry is on its way back.");
  });

  it("a no-show ends as a refund less the Platform Fee each side paid", () => {
    const noShow = during({ stage: { settling: {} }, run: run({ noShow: {} }, [4, 0, 0]) });
    expect(spectateState(noShow, true)).toBe("refunding");
    expect(spectateFee(noShow, "refunding")).toEqual({ label: "Fee charged", fee: 4 });
    const page = text(view(noShow, true));
    expect(page).toContain("Each entry is on its way back, less the Platform Fee.");
    expect(page).not.toContain("Both entries are on their way back");
  });

  it("a draw being paid says the entries go back, not that a Pot is paid out", () => {
    const draw = during({ stage: { refunding: {} }, run: run({ draw: {} }) });
    expect(spectateState(draw, true)).toBe("settling");
    const page = text(view(draw, true));
    expect(page).toContain("Draw");
    expect(page).toContain("The result is final and both entries are on their way back.");
    expect(page).not.toContain("Pot is being paid out");
    expect(text(view(winning, true))).toContain("The result is final and the Pot is being paid out.");
  });
});

describe("the Fee a spectator sees", () => {
  it("is the Fee on a win while the outcome is pending, never 0 for a Match with Fee terms", () => {
    // 200 Pot at 2% Platform + 3% Studio + 1% Leaderboard.
    for (const [m, tabled] of [[open, false], [waiting, false], [waiting, true]] as const) {
      expect(spectateFee(m, spectateState(m, tabled))).toEqual({ label: "Fee on a win", fee: 12 });
      expect(text(view(m, tabled))).toContain("Fee on a win 12 Gemas");
    }
  });

  it("is the Fee charged once a win is fixed and after it is paid", () => {
    for (const m of [winning, won]) {
      const state = spectateState(m, true);
      expect(spectateFee(m, state)).toEqual({ label: "Fee charged", fee: 12 });
      const page = text(view(m, true));
      expect(page).toMatch(/\S+ won/);
      expect(page).toContain("Fee charged 12 Gemas");
      expect(page).toContain("Pot 200 − Fee 12 = 188 to the winner");
      expect(page).not.toContain("Fee on a win");
    }
  });

  it("is the Fee charged, 0, on a full refund: while it is refunding and once it is refunded", () => {
    for (const m of [refunding, refunded]) {
      expect(spectateFee(m, spectateState(m, false))).toEqual({ label: "Fee charged", fee: 0 });
      const page = text(view(m));
      expect(page).toContain("Fee charged 0 Gemas");
      expect(page).not.toContain("Fee on a win");
    }
  });

  it("is the Fee the history recorded for a closed Match", () => {
    const a = Keypair.generate().publicKey.toBase58();
    const b = Keypair.generate().publicKey.toBase58();
    const page: MatchPage = {
      id: `${a}-9`, game: "block-puzzle", entry: 500, status: "settled", kind: 0, challenge: false, asset: 0, openedAt: 1_791_200_000_000, settledAt: 1_791_200_900_000,
      sides: [{ player: a, funder: a }, { player: b, funder: b }], winnerSide: 1, winner: b, loser: a, points: 5, season: 3,
      fees: { platform: 20, studio: 30, leaderboard: 10 }, chunks: 2, scores: [200, 410], parties: [],
    };
    const win = chainMatchFromPage(page, null)!;
    expect(spectateFee(win, spectateState(win, false))).toEqual({ label: "Fee charged", fee: 60 });
    const refund = chainMatchFromPage({ ...page, status: "refunded", kind: 6, winnerSide: null, winner: null, loser: null, points: null, fees: { platform: 0, studio: 0, leaderboard: 0 }, scores: null }, null)!;
    expect(spectateFee(refund, spectateState(refund, false))).toEqual({ label: "Fee charged", fee: 0 });
  });
});

describe("a spectator who keeps the page open", () => {
  /** Plays a list of chain reads through the page's poll and returns the headline after each one. */
  async function watch(reads: { m: ChainMatch | null | "fails"; tabled?: boolean | "fails"; how?: ClosedOutcome }[]): Promise<string[]> {
    let seen: Spectated | null | undefined;
    const out: string[] = [];
    for (const [i, r] of reads.entries()) {
      // As the page does: once a table was seen, the Assignment is not read again.
      const next = await readSpectated("id", {
        fetchMatch: async () => {
          if (r.m === "fails") throw new Error("read failed");
          return r.m;
        },
        tabled: async () => {
          if (r.tabled === "fails") throw new Error("read failed");
          return r.tabled ?? false;
        },
        outcome: async () => r.how ?? null,
        now: () => (JOINED_AT + i * 5) * 1000,
      }, seen);
      seen = laterRead(seen, next);
      out.push(seen ? spectateHeadline(stateOf(seen), seen.m && winSeatOf(seen) !== null ? "Ben" : null, seen.closed) : seen === null ? "Match not found" : "Loading");
    }
    return out;
  }

  it("follows the untabled refund of the QA Match through every transition", async () => {
    expect(await watch([{ m: open }, { m: waiting }, { m: waiting }, { m: refunding }, { m: refunding }, { m: refunded }])).toEqual([
      "Waiting for an opponent", "Waiting for a table", "Waiting for a table", "Refunding", "Refunding", "Refunded",
    ]);
  });

  it("follows a played Match: table, in play, won", async () => {
    expect(await watch([{ m: waiting }, { m: waiting, tabled: true }, { m: winning, tabled: true }, { m: won, tabled: true }])).toEqual([
      "Waiting for a table", "In play", "Ben won", "Ben won",
    ]);
  });

  it("stays In play once a table was seen, without reading the Assignment again", async () => {
    expect(await watch([{ m: waiting, tabled: true }, { m: waiting, tabled: "fails" }, { m: waiting, tabled: false }])).toEqual(["In play", "In play", "In play"]);
  });

  it("keeps what it showed when a read fails or the closed Match is not in the history yet", async () => {
    // The Match account is closed a moment before the history has its result: a read then finds nothing, or a page without a result.
    const lagging = { ...chainMatchFromPage({ id: refunding.id, game: "block-puzzle", entry: 100, status: "seen", kind: null, challenge: false, asset: 0, openedAt: refunding.openedAt, settledAt: null, sides: [{ player: refunding.sides[0].player, funder: refunding.sides[0].funder }, { player: refunding.sides[1]!.player, funder: refunding.sides[1]!.funder }], winnerSide: null, winner: null, loser: null, points: null, season: null, fees: { platform: 0, studio: 0, leaderboard: 0 }, chunks: 0, scores: null, parties: [] }, null)! };
    expect(await watch([{ m: waiting, tabled: true }, { m: "fails" }, { m: waiting, tabled: "fails" }, { m: refunding }, { m: null }, { m: lagging }, { m: refunded }])).toEqual([
      "In play", "In play", "In play", "Refunding", "Refunding", "Refunding", "Refunded",
    ]);
  });

  it("does not guess on a fresh link: no headline until the Match and its table are both read", async () => {
    expect(await watch([{ m: "fails" }, { m: waiting, tabled: "fails" }, { m: waiting }])).toEqual(["Loading", "Loading", "Waiting for a table"]);
    expect(await watch([{ m: null }])).toEqual(["Match not found"]);
    expect(keepsReading(null)).toBe(false);
  });

  it("a fresh link to a Match that is closed but not in the history yet says it is over, and keeps reading for the result", async () => {
    const lagging = chainMatchFromPage({ id: refunding.id, game: "block-puzzle", entry: 100, status: "seen", kind: null, challenge: false, asset: 0, openedAt: refunding.openedAt, settledAt: null, sides: [{ player: refunding.sides[0].player, funder: refunding.sides[0].funder }, { player: refunding.sides[1]!.player, funder: refunding.sides[1]!.funder }], winnerSide: null, winner: null, loser: null, points: null, season: null, fees: { platform: 0, studio: 0, leaderboard: 0 }, chunks: 0, scores: null, parties: [] }, null)!;
    expect(await watch([{ m: lagging }, { m: lagging }, { m: refunded }])).toEqual(["Match over", "Match over", "Refunded"]);
    const seen = (await readSpectated("id", { fetchMatch: async () => lagging, tabled: async () => true, outcome: async () => null, now: () => 0 }))!;
    expect(stateOf(seen)).toBe("over");
    expect(keepsReading(seen)).toBe(true);
    const page = text(renderToStaticMarkup(<SpectateView seen={seen} />));
    expect(page).toContain("The amounts are still being recorded");
    expect(page).not.toMatch(/In play|Fee on a win|Fee charged/);
  });

  // The sponsored QA Match of 2026-11-27 (7k1s…BmN3-28): closed on the chain at 12:40:39, in the history at about 12:45:15.
  it("names the winner from the chain's receipt when the Match closes before the page saw it settle", async () => {
    expect(await watch([{ m: waiting, tabled: true }, { m: null, how: "opener" }, { m: null, how: "opener" }, { m: won }])).toEqual(["In play", "Ben won", "Ben won", "Ben won"]);
    expect(await watch([{ m: waiting, tabled: true }, { m: null, how: "refund" }, { m: refunded }])).toEqual(["In play", "Refunded", "Refunded"]);
    const seen = (await readSpectated("id", { fetchMatch: async () => null, tabled: async () => true, outcome: async () => "joiner", now: () => 0 }, { m: waiting, tabled: true, at: 0 }))!;
    expect(seen).toMatchObject({ closed: "joiner", tabled: true });
    expect(winSeatOf(seen)).toBe(1);
    expect(keepsReading(seen)).toBe(true);
    const page = text(renderToStaticMarkup(<SpectateView seen={seen} />));
    expect(page).toMatch(/\S+ won/);
    expect(page).toContain("The amounts are still being recorded");
    expect(page).not.toMatch(/In play|Fee on a win|Fee charged|Winner gains/);
  });

  it("a fresh link to a Match that just closed says it is over, not that it does not exist, and keeps reading", async () => {
    expect(await watch([{ m: null, how: "joiner" }, { m: null, how: "joiner" }, { m: won }])).toEqual(["Match over", "Match over", "Ben won"]);
    expect(await watch([{ m: null, how: "refund" }, { m: refunded }])).toEqual(["Refunded", "Refunded"]);
    const seen = (await readSpectated("id", { fetchMatch: async () => null, tabled: async () => true, outcome: async () => "joiner", now: () => 0 }))!;
    expect(seen.m).toBeNull();
    expect(keepsReading(seen)).toBe(true);
    const page = text(renderToStaticMarkup(<SpectateView seen={seen} />));
    expect(page).toContain("Match over");
    expect(page).toContain("The Players and the amounts are still being recorded");
    expect(page).not.toContain("Match not found");
  });

  it("reads the outcome off a receipt's run kind", () => {
    expect([{ win: { winner: 0 } }, { win: { winner: 1 } }, { draw: {} }, { noShow: {} }, { cancelled: {} }, { abandoned: {} }, { gameUpgraded: {} }, { byGame: {} }].map(outcomeOfKind)).toEqual(["opener", "joiner", "draw", "refund", "refund", "refund", "refund", "refund"]);
  });

  it("reads again until the Match is refunded or settled, and not after", () => {
    const at = (m: ChainMatch, tabled = true): Spectated => ({ m, tabled, at: 0 });
    expect([undefined, at(open, false), at(waiting, false), at(waiting), at(refunding), at(winning)].map(keepsReading)).toEqual([true, true, true, true, true, true]);
    expect([null, at(refunded), at(won)].map(keepsReading)).toEqual([false, false, false]);
  });
});
