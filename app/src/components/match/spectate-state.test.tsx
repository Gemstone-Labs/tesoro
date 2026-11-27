import { Keypair } from "@solana/web3.js";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chainMatchFromPage, toChainMatch, type ChainMatch } from "@/lib/chain/read";
import { setLeaderboardSince } from "@/lib/chain/season";
import type { MatchPage } from "@/server/history/reads";
import { SpectateView } from "./MatchSpectate";
import { laterRead, readSpectated, spectateFee, spectateHeadline, spectateState, type Spectated } from "./spectate-state";
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
  async function watch(reads: { m: ChainMatch | null | "fails"; tabled?: boolean | "fails" }[]): Promise<string[]> {
    let seen: Spectated | null | undefined;
    const out: string[] = [];
    for (const [i, r] of reads.entries()) {
      const next = await readSpectated("id", {
        fetchMatch: async () => {
          if (r.m === "fails") throw new Error("read failed");
          return r.m;
        },
        tabled: async () => {
          if (r.tabled === "fails") throw new Error("read failed");
          return r.tabled ?? false;
        },
        now: () => (JOINED_AT + i * 5) * 1000,
      });
      seen = laterRead(seen, next);
      out.push(seen ? spectateHeadline(spectateState(seen.m, seen.tabled), "Ben") : seen === null ? "Match not found" : "Loading");
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
  });

  it("stops reading once the Match is refunded or settled, and not before", () => {
    const final = (m: ChainMatch, tabled: boolean) => ["settled", "refunded"].includes(spectateState(m, tabled));
    expect([open, waiting, refunding, winning].map((m) => final(m, true))).toEqual([false, false, false, false]);
    expect([refunded, won].map((m) => final(m, true))).toEqual([true, true]);
  });
});
