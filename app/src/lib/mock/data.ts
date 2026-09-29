import type {
  Account,
  GameId,
  GemaHolding,
  Match,
  Offer,
  PlayerRecord,
  Position,
  Request,
} from "./types";

/** Fixed clock so server and client render identically. */
export const MOCK_NOW = "2026-10-01T12:00:00Z";

export const account: Account = {
  id: "acct_you",
  displayName: "You",
  addresses: {
    solana: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
    evm: "0x4Ce2a8b91F0d3E57c1A6d9f2B08E7a3d51c6F9a2",
  },
};

export const positions: Position[] = [
  {
    id: "pos_sol",
    chain: "SOL",
    asset: "SOL",
    principal: 40,
    apy: 0.07,
    debt: 0.55,
    advance: {
      id: "adv_sol",
      positionId: "pos_sol",
      horizonMonths: 3,
      gemasIssued: 10500,
      projectedYield: 0.7,
      issuedAt: "2026-10-01T11:50:00Z",
      unlockEstimate: "2026-10-01T12:20:00Z",
    },
  },
  {
    id: "pos_eth",
    chain: "ETH",
    asset: "ETH",
    principal: 2,
    apy: 0.03,
    debt: 0,
    advance: null,
  },
  {
    id: "pos_hype",
    chain: "HYPE",
    asset: "HYPE",
    principal: 150,
    apy: 0.022,
    debt: 0.2,
    advance: {
      id: "adv_hype",
      positionId: "pos_hype",
      horizonMonths: 1,
      gemasIssued: 1100,
      projectedYield: 0.275,
      issuedAt: "2026-10-01T11:55:00Z",
      unlockEstimate: "2026-10-01T12:05:00Z",
    },
  },
];

export const holdings: GemaHolding[] = [
  {
    source: { positionId: "pos_sol", chain: "SOL", asset: "SOL", owner: "Your Position", advanceId: "adv_sol" },
    gemas: 5200,
    accruedShare: 0.17,
    own: true,
  },
  {
    source: { positionId: "pos_hype", chain: "HYPE", asset: "HYPE", owner: "Your Position", advanceId: "adv_hype" },
    gemas: 1100,
    accruedShare: 0.32,
    own: true,
  },
  {
    source: { positionId: "pos_bob_hype", chain: "HYPE", asset: "HYPE", owner: "Bob's Position", advanceId: "adv_bob" },
    gemas: 2500,
    accruedShare: 0.12,
    own: false,
  },
  {
    source: { positionId: "pos_carol_eth", chain: "ETH", asset: "ETH", owner: "Carol's Position", advanceId: "adv_carol" },
    gemas: 1260,
    accruedShare: 0.05,
    own: false,
  },
];

export const matches: Match[] = [
  { id: "m4", game: "block-puzzle", entry: 1000, opponent: "Bob", result: "won", gemasDelta: 1900, seed: "0x9f3a…c21e", playedAt: "2026-10-01T11:31:00Z", backed: false },
  { id: "m3", game: "holdem", entry: 500, opponent: "Carol", result: "won", gemasDelta: 950, seed: "0x51b0…7d04", playedAt: "2026-10-01T11:12:00Z", backed: false },
  { id: "m2", game: "block-puzzle", entry: 1000, opponent: "Mika", result: "lost", gemasDelta: -1000, seed: "0xa7c4…19be", playedAt: "2026-10-01T10:44:00Z", backed: false },
  { id: "m1", game: "block-puzzle", entry: 500, opponent: "Ines", result: "refunded", gemasDelta: 0, seed: "0x02de…88f1", playedAt: "2026-09-30T18:20:00Z", backed: false },
];

const dana: PlayerRecord = { id: "p_dana", name: "Dana", matches: 38, winRate: 0.61 };
const marco: PlayerRecord = { id: "p_marco", name: "Marco", matches: 12, winRate: 0.5 };
const ines: PlayerRecord = { id: "p_ines", name: "Ines", matches: 71, winRate: 0.58 };
const tomas: PlayerRecord = { id: "p_tomas", name: "Tomás", matches: 24, winRate: 0.54 };

export const requests: Request[] = [
  { id: "req_dana", player: dana, game: "block-puzzle", entry: 1000, postedAt: "2026-10-01T11:40:00Z" },
  { id: "req_ines", player: ines, game: "block-puzzle", entry: 2500, postedAt: "2026-10-01T11:05:00Z" },
  { id: "req_marco", player: marco, game: "holdem", entry: 500, postedAt: "2026-10-01T09:50:00Z" },
];

export const offers: Offer[] = [
  { id: "off_lumen", backer: "Lumen", game: "block-puzzle", entry: 1000, playerShare: 40, requestId: null, applicants: [] },
  { id: "off_kestrel", backer: "Kestrel", game: "holdem", entry: 500, playerShare: 50, requestId: null, applicants: [] },
  { id: "off_you", backer: "You", game: "block-puzzle", entry: 2500, playerShare: 35, requestId: null, applicants: [ines, tomas] },
];

export const GAME_NAMES: Record<GameId, string> = {
  "block-puzzle": "Block Puzzle",
  holdem: "Heads-up Hold'em",
};

/** Current Queue depth per game (example figures). */
export const queueDepth: Record<GameId, number> = { "block-puzzle": 4, holdem: 2 };
