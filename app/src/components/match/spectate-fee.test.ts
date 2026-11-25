import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { chainMatchFromPage } from "@/lib/chain/read";
import type { MatchPage } from "@/server/history/reads";
import { spectatorPot } from "./MatchSpectate";

const a = Keypair.generate().publicKey;
const b = Keypair.generate().publicKey;

// The QA Block Burst Match of 2026-11-25: 500 each, 20 Platform + 30 Studio + 10 Leaderboard, the winner received 940.
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

describe("a spectator's Pot line for a closed Match", () => {
  it("takes the Fees the Match settled with, not 0 from the history's missing rates", () => {
    const m = chainMatchFromPage(page, null)!;
    expect(spectatorPot(m)).toEqual({ fee: 60, payout: 940 });
  });

  it("works the Fee out from the rates while the Match is live", () => {
    const m = { ...chainMatchFromPage(page, null)!, status: "active" as const, settled: null, fees: { platformBps: 200, studioBps: 300, leaderboardBps: 100 } };
    expect(spectatorPot(m)).toEqual({ fee: 60, payout: 940 });
  });
});
