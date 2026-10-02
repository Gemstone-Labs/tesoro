/**
 * DEV ONLY (NEXT_PUBLIC_DEV_WALLET=1, never in production builds): a populated fake Account so the
 * shell and Lobby can be reviewed and screenshotted with data. Open the app with `?dev=demo`.
 * Nothing here is read from chain.
 */
import { PublicKey } from "@solana/web3.js";
import { DEV_WALLET } from "./config";
import type { BackingBoard, ChainRequest } from "./backing";
import type { PlayerAccount } from "./player-account";
import type { AccountSnapshot, ChainHolding, ChainMatch, ChainPosition } from "./read";
import type { SettledMatch } from "./recent";

export function demoMode(): boolean {
  if (!DEV_WALLET || typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem("tesoro-dev-slot") === "demo";
  } catch {
    return false;
  }
}

const key = (seed: number) => PublicKey.findProgramAddressSync([Buffer.from(`demo-${seed}`)], PublicKey.default)[0];
const ago = (mins: number) => Date.now() - mins * 60_000;
const idAt = (ms: number) => BigInt(ms) << 1n;

export function match(
  game: "block-puzzle" | "holdem",
  entry: number,
  win: boolean,
  mins: number,
  scores: [number, number],
  me = key(1).toBase58(),
): ChainMatch {
  const id = idAt(ago(mins));
  const them = key(2 + mins).toBase58();
  return {
    id,
    game,
    address: key(100 + mins),
    status: "settled",
    entry,
    seat: 0,
    opponent: them,
    deadline: 0,
    challenge: false,
    sides: [
      { player: me, funder: me, shareBps: 0 },
      { player: them, funder: them, shareBps: 0 },
    ],
    backerSeat: null,
    backing: null,
    fees: { platformBps: 500, studioBps: 0 },
    winner: game === "holdem" ? (win ? "opener" : "joiner") : null,
    session:
      game === "block-puzzle"
        ? { settled: true, joined: true, result: win ? "opener" : "joiner", scores: win ? scores : [scores[1], scores[0]], seed: 0n, openerDeadline: 0, deadline: 0 }
        : null,
  };
}

/** The same Match played under a Backing (or, with `asBacker`, funded by this Account for another Player). */
export function backed(m: ChainMatch, other: string, shareBps = 4000, asBacker = false): ChainMatch {
  const me = m.sides[0].player;
  const player = asBacker ? other : me;
  const funder = asBacker ? me : other;
  return {
    ...m,
    seat: asBacker ? null : 0,
    backerSeat: asBacker ? 0 : null,
    sides: [{ player, funder, shareBps }, m.sides[1]],
    backing: { seat: 0, player, funder, shareBps },
  };
}

export function demoSnapshot(address: string): AccountSnapshot {
  const holding = (n: number, isOwn: boolean, amount: bigint, redeemable: bigint, asset: "SOL" | "HYPE"): ChainHolding => ({
    holding: key(200 + n),
    source: key(300 + n),
    position: key(400 + n),
    isOwn,
    amount,
    reserved: 0n,
    free: amount,
    redeemable,
    sourceDebt: 0n,
    sourceOwner: isOwn ? address : key(500 + n).toBase58(),
    asset,
    native: false,
    eth: null,
  });
  const position: ChainPosition = {
    address: key(400 + 1),
    asset: "SOL",
    principal: 40,
    apy: 0.07,
    status: "locked",
    advances: 1,
    advance: { source: key(300 + 1), gemasIssued: 10500, horizonMonths: 3, debtGemas: 5500 },
    debt: 0.55,
    yieldAccrued: 0.15,
    native: null,
    eth: null,
  };
  return {
    exists: true,
    accountKey: key(1),
    lamports: 2_000_000_000,
    ownTotal: 3500n,
    wonTotal: 1500n,
    holdings: [holding(1, true, 3500n, 1240n, "SOL"), holding(2, false, 1500n, 0n, "HYPE")],
    positions: [position],
    matches: [
      match("block-puzzle", 1000, true, 2, [171, 55]),
      backed(match("block-puzzle", 1000, false, 7, [96, 140]), key(801).toBase58()),
      match("holdem", 2500, true, 12, [2, 0]),
      match("block-puzzle", 1000, false, 240, [102, 133]),
      match("holdem", 1000, false, 1440, [1, 2]),
      // Older history, enough for a second page of All Matches.
      ...Array.from({ length: 18 }, (_, i) =>
        match(i % 3 === 0 ? "holdem" : "block-puzzle", [500, 1000, 2500][i % 3], i % 4 !== 1, 1500 + i * 97, [120 + ((i * 7) % 40), 80 + ((i * 11) % 50)]),
      ),
    ],
    market: null,
    funded: [backed(match("block-puzzle", 2500, true, 30, [150, 88]), key(802).toBase58(), 4000, true)],
    fetchedAt: Date.now(),
  };
}

export function demoBoard(): BackingBoard {
  const req = (n: number, game: "block-puzzle" | "holdem", entry: number, matches: number, wins: number): ChainRequest => ({
    address: key(600 + n),
    nonce: BigInt(n),
    player: key(700 + n).toBase58(),
    game,
    entry,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    status: "open",
    live: true,
    record: { matches, wins },
  });
  return {
    requests: [req(1, "block-puzzle", 1000, 38, 23), req(2, "holdem", 500, 24, 14), req(3, "block-puzzle", 2500, 52, 34), req(4, "holdem", 1000, 17, 9)],
    offers: [],
    fetchedAt: Date.now(),
  };
}

export function demoSettled(): SettledMatch[] {
  return [
    { id: idAt(ago(2)), game: "block-puzzle", entry: 1000, winner: key(701).toBase58(), payout: 1900, scores: [171, 55], at: ago(2) },
    { id: idAt(ago(9)), game: "holdem", entry: 2500, winner: key(702).toBase58(), payout: 4750, scores: null, at: ago(9) },
    { id: idAt(ago(21)), game: "block-puzzle", entry: 500, winner: key(703).toBase58(), payout: 950, scores: [133, 102], at: ago(21) },
  ];
}

/** Addresses for the Account page's other states: an Account that has not played, and an address with no Account. */
export const DEMO_NEW_ACCOUNT = key(998).toBase58();
export const DEMO_NO_ACCOUNT = key(999).toBase58();

/** Any Player's Account as others see it. The signed-in demo Account shows its own Matches; every other key gets the same varied history. */
export function demoPlayerAccount(address: string): PlayerAccount {
  if (address === DEMO_NO_ACCOUNT) return { exists: false, played: [], requests: [] };
  if (address === DEMO_NEW_ACCOUNT) return { exists: true, played: [], requests: [] };
  if (address === key(1).toBase58()) return { exists: true, played: demoSnapshot(address).matches, requests: [] };
  const m = (game: "block-puzzle" | "holdem", entry: number, win: boolean, mins: number, scores: [number, number] = [0, 0]) =>
    match(game, entry, win, mins, scores, address);
  const [backerA, backerB] = [key(801).toBase58(), key(802).toBase58()];
  const draw = m("block-puzzle", 1000, true, 600, [118, 118]);
  const played: ChainMatch[] = [
    m("block-puzzle", 1000, true, 4, [171, 55]),
    backed(m("block-puzzle", 1000, true, 35, [150, 88]), backerA),
    m("holdem", 2500, false, 90),
    backed(m("holdem", 1000, false, 180), backerA),
    backed(m("block-puzzle", 2500, true, 300, [164, 97]), backerB, 3000),
    m("block-puzzle", 500, true, 420, [133, 102]),
    { ...draw, status: "refunded", session: draw.session && { ...draw.session, result: "draw" } },
    { ...m("holdem", 1000, false, 720), status: "refunded", winner: null },
    backed(m("block-puzzle", 1000, false, 900, [96, 140]), backerB, 3000),
    ...Array.from({ length: 24 }, (_, i) =>
      m(i % 3 === 0 ? "holdem" : "block-puzzle", [500, 1000, 2500][i % 3], i % 5 !== 2, 1500 + i * 97, [120 + ((i * 7) % 40), 80 + ((i * 11) % 50)]),
    ),
  ];
  return { exists: true, played, requests: demoBoard().requests.filter((r) => r.player === address) };
}
