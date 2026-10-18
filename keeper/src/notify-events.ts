import { BLOCK_PUZZLE_PROGRAM_ID, BlockPuzzleChain } from "../../app/src/games/block-puzzle/chain.ts";
import { POSITION_SPACE } from "../../app/src/lib/chain/position-size.ts";
import { HOLDEM_PROGRAM_ID } from "../../app/src/games/holdem/chain.ts";
import { TRADING_DUEL_PROGRAM_ID } from "../../app/src/games/trading-duel/chain.ts";
import { fetchSeasonRecord } from "../../app/src/lib/chain/leaderboard.ts";
import { delayedOf } from "../../app/src/lib/chain/match-status.ts";
import { seasonsToCheck } from "./season.ts";
import { DELEGATION_PROGRAM_ID } from "@magicblock-labs/ephemeral-rollups-sdk";
import { PublicKey } from "@solana/web3.js";
import { log, type Ctx } from "./act.ts";
import type { GameId } from "./notify.ts";
import { pk } from "./runtime.ts";

/** One fact for a Player's Account (`account` is a TesoroAccount key); the job turns it into the app's wire event with the wallet authority. */
export type Fact = { account: string } & (
  | { kind: "opponent-played"; matchId: string; game: GameId }
  | { kind: "match-delayed"; matchId: string; game: GameId; refundBy: number; refundOpen: boolean }
  | { kind: "match-refunded"; matchId: string; game: GameId; entry: number }
  | { kind: "offer-made"; offerId: string; game: GameId; entry: number }
  | { kind: "offer-accepted"; offerId: string; game: GameId; entry: number }
  | { kind: "debt-cleared"; positionId: string; advance: number; asset: string }
  | { kind: "season-placed"; season: number; rank: number; gemas: number }
);

/** Matches whose refund deadline passed longer ago than this are not announced (a restart does not replay old history). */
const WINDOW_SECS = 3 * 24 * 3600;
/** Block Puzzle Matches whose Session and Boards are read per pass. */
const BP_PER_PASS = 15;
const EVENTS_PER_PUSH = 50;

export interface MatchFacts {
  id: bigint;
  game: GameId;
  status: "open" | "active" | "settled" | "refunded";
  /** tesoro_core's refund deadline, unix seconds. */
  deadline: number;
  entry: number;
  /** TesoroAccount keys of the Players. */
  players: string[];
  /** Block Puzzle Session deadlines, when read. */
  session: { deadline: number; openerDeadline: number } | null;
}

/** Refunded and Delayed Matches, for each Player. Delayed follows match-status's rule, so it agrees with the app. */
export function matchFacts(m: MatchFacts, nowSecs: number): Fact[] {
  if (nowSecs - m.deadline > WINDOW_SECS) return [];
  const matchId = m.id.toString();
  if (m.status === "refunded") return m.players.map((account) => ({ account, kind: "match-refunded", matchId, game: m.game, entry: m.entry }));
  const late = delayedOf({ status: m.status, game: m.game, deadline: m.deadline, session: m.session as any }, nowSecs);
  if (!late) return [];
  return m.players.map((account) => ({ account, kind: "match-delayed", matchId, game: m.game, refundBy: m.deadline, refundOpen: late.refundOpen }));
}

export interface BoardFacts {
  /** The Board is in the rollup (its Player began a run). */
  delegated: boolean;
  sealed: boolean;
}

/** Block Puzzle: the opener played first and the joiner has played now. Only for an Active Match with a joined Session. */
export function opponentPlayedFact(m: { id: bigint; opener: string }, joined: boolean, boards: [BoardFacts, BoardFacts]): Fact | null {
  const played = (b: BoardFacts) => b.delegated || b.sealed;
  if (!joined || !played(boards[0]) || !played(boards[1])) return null;
  return { account: m.opener, kind: "opponent-played", matchId: m.id.toString(), game: "block-puzzle" };
}

export interface OfferFacts {
  address: string;
  /** TesoroAccount key of the Backer. */
  backer: string;
  game: GameId;
  entry: number;
  status: string;
  expiresAt: number;
  useBy: number;
  /** Request address a directed Offer answers. */
  directedTo: string | null;
}

/** An open Offer made on a Request tells the Request's Player; an accepted Offer (still to be used) tells its Backer. */
export function offerFacts(offers: OfferFacts[], requestPlayer: Map<string, string>, nowSecs: number): Fact[] {
  const out: Fact[] = [];
  for (const o of offers) {
    if (o.status === "open" && nowSecs < o.expiresAt && o.directedTo) {
      const player = requestPlayer.get(o.directedTo);
      if (player) out.push({ account: player, kind: "offer-made", offerId: o.address, game: o.game, entry: o.entry });
    } else if (o.status === "accepted" && nowSecs < o.useBy) {
      out.push({ account: o.backer, kind: "offer-accepted", offerId: o.address, game: o.game, entry: o.entry });
    }
  }
  return out;
}

export interface PositionFacts {
  address: string;
  owner: string;
  locked: boolean;
  /** Index of the open Advance (the one with Debt), null without Debt. */
  openAdvance: number | null;
  asset: string;
}

/**
 * A Position that had Debt and now has none. Chain state has no timestamp for this, so it is seen as a change between
 * two passes: `before` is the open Advance of each Position with Debt last pass, `null` on the first pass (which only
 * records). A Debt that cleared while the keeper was down is not announced.
 */
export function debtClearedFacts(before: Map<string, number> | null, positions: PositionFacts[]): { facts: Fact[]; after: Map<string, number> } {
  const after = new Map<string, number>();
  const facts: Fact[] = [];
  for (const p of positions) {
    if (p.locked && p.openAdvance !== null) after.set(p.address, p.openAdvance);
    else if (before?.has(p.address) && p.locked) facts.push({ account: p.owner, kind: "debt-cleared", positionId: p.address, advance: before.get(p.address)!, asset: p.asset });
  }
  return { facts, after };
}

/** Each rank of a Season that has been paid. */
export function seasonFacts(rec: { number: number; count: number; winners: string[]; amounts: bigint[]; paidMask: number }): Fact[] {
  const out: Fact[] = [];
  for (let i = 0; i < rec.count; i++) {
    if (rec.paidMask & (1 << i)) out.push({ account: rec.winners[i], kind: "season-placed", season: rec.number, rank: i + 1, gemas: Number(rec.amounts[i]) });
  }
  return out;
}

/** The daily digest is due from `hourUtc` on, once per UTC day. */
export function digestDue(nowMs: number, lastDay: string | null, hourUtc: number): boolean {
  const d = new Date(nowMs);
  return d.getUTCHours() >= hourUtc && d.toISOString().slice(0, 10) !== lastDay;
}

const post = async (url: string, secret: string, body: unknown, fetchFn: typeof fetch) => {
  try {
    const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
    return res.ok;
  } catch {
    return false;
  }
};

/** True when the server took the events (2xx). Never throws: the next pass tries again. */
export const pushEvents = (url: string, secret: string, events: object[], fetchFn: typeof fetch = fetch) => post(url, secret, { events }, fetchFn);
/** True when the server ran the digest. */
export const pushDigest = (url: string, secret: string, fetchFn: typeof fetch = fetch) => post(url, secret, {}, fetchFn);

const told = new Set<string>();
const authorities = new Map<string, string>();
let owed: Map<string, number> | null = null;
let digestDay: string | null = null;

const status = (o: object) => Object.keys(o)[0];
const gameOfKey = (k: PublicKey): GameId | null =>
  k.equals(BLOCK_PUZZLE_PROGRAM_ID) ? "block-puzzle" : k.equals(HOLDEM_PROGRAM_ID) ? "holdem" : k.equals(TRADING_DUEL_PROGRAM_ID) ? "trading-duel" : null;
const ASSET: Record<string, string> = { solana: "SOL", ethereum: "ETH", hyperEvm: "HYPE", hyperevm: "HYPE" };

async function authorityOf(ctx: Ctx, account: string): Promise<string | null> {
  const known = authorities.get(account);
  if (known) return known;
  try {
    const a = (await ctx.core.account.tesoroAccount.fetch(new PublicKey(account))).authority.toBase58();
    authorities.set(account, a);
    return a;
  } catch {
    return null;
  }
}

async function matchesFacts(ctx: Ctx): Promise<Fact[]> {
  const all: any[] = await ctx.core.account.matchState.all();
  const facts: Fact[] = [];
  const bp: { id: bigint; opener: string }[] = [];
  for (const { account } of all) {
    const st = status(account.inner.status);
    const game = gameOfKey(pk(account.inner.game));
    if (!game || st === "settled" || st === "open") continue;
    const m = account.inner;
    const id = BigInt(account.id.toString());
    const players = [m.a, m.b].filter(Boolean).map((s: any) => pk(s.player).toBase58());
    const base = { id, game, status: st as MatchFacts["status"], deadline: Number(m.deadline.toString()), entry: Number(m.entry.toString()), players };
    if (st === "active" && game === "block-puzzle") bp.push({ id, opener: players[0] });
    else facts.push(...matchFacts({ ...base, session: null }, ctx.now));
  }
  // Block Puzzle: its Session gives the Delayed deadlines, and Session + Boards say whether the opponent has played.
  for (const m of bp.slice(0, BP_PER_PASS)) {
    const row = all.find((r) => BigInt(r.account.id.toString()) === m.id)!;
    const a = BlockPuzzleChain.addresses(m.id);
    const [sInfo, b0, b1] = await ctx.conn.getMultipleAccountsInfo([a.session, ...a.boards]);
    let session: any = null;
    try {
      session = sInfo ? ctx.bp.bp.coder.accounts.decode("session", sInfo.data) : null;
    } catch {}
    const decodeBoard = (info: typeof b0) => {
      try {
        return info && info.owner.equals(BLOCK_PUZZLE_PROGRAM_ID) ? ctx.bp.bp.coder.accounts.decode("board", info.data) : null;
      } catch {
        return null;
      }
    };
    const boardFacts = (info: typeof b0): BoardFacts => ({ delegated: !!info?.owner.equals(DELEGATION_PROGRAM_ID), sealed: !!decodeBoard(info)?.sealed });
    const players = [row.account.inner.a, row.account.inner.b].filter(Boolean).map((s: any) => pk(s.player).toBase58());
    const sess = session ? { deadline: Number(session.deadline.toString()), openerDeadline: Number(session.openerDeadline.toString()) } : null;
    facts.push(...matchFacts({ id: m.id, game: "block-puzzle", status: "active", deadline: Number(row.account.inner.deadline.toString()), entry: Number(row.account.inner.entry.toString()), players, session: sess }, ctx.now));
    const played = session && opponentPlayedFact(m, !!session.joined && !session.settled, [boardFacts(b0), boardFacts(b1)]);
    if (played) facts.push(played);
  }
  return facts;
}

async function backingFacts(ctx: Ctx): Promise<Fact[]> {
  const [requests, offers]: any[][] = await Promise.all([ctx.core.account.requestState.all(), ctx.core.account.offerState.all()]);
  const requestPlayer = new Map<string, string>(requests.map((r) => [(r.publicKey as PublicKey).toBase58(), pk(r.account.inner.player).toBase58()]));
  const directed = (k: any): string | null => {
    const v = k.directed ?? null;
    return v ? pk(Array.isArray(v) ? v[0] : (v[0] ?? v._0 ?? v)).toBase58() : null;
  };
  const rows: OfferFacts[] = offers.flatMap(({ publicKey, account }) => {
    const o = account.inner;
    const game = gameOfKey(pk(o.game));
    return game
      ? [{ address: (publicKey as PublicKey).toBase58(), backer: pk(o.backer).toBase58(), game, entry: Number(o.entry.toString()), status: status(o.status), expiresAt: Number(o.expiresAt.toString()), useBy: Number(o.useBy.toString()), directedTo: directed(o.kind) }]
      : [];
  });
  return offerFacts(rows, requestPlayer, ctx.now);
}

async function positionFacts(ctx: Ctx): Promise<Fact[]> {
  const positions: any[] = await ctx.core.account.positionState.all([{ dataSize: POSITION_SPACE }]);
  const rows: PositionFacts[] = positions.map(({ publicKey, account }) => {
    const i = account.inner;
    const open = i.openAdvance;
    return {
      address: (publicKey as PublicKey).toBase58(),
      owner: pk(i.owner).toBase58(),
      locked: status(i.status) === "locked",
      openAdvance: open === null || open === undefined ? null : Number(open),
      asset: ASSET[status(i.sourceChain)] ?? "",
    };
  });
  const { facts, after } = debtClearedFacts(owed, rows);
  owed = after;
  return facts.filter((f) => f.kind !== "debt-cleared" || f.asset !== "");
}

async function seasonPaidFacts(ctx: Ctx): Promise<Fact[]> {
  const out: Fact[] = [];
  for (const n of seasonsToCheck(ctx.now, undefined, 1)) {
    const rec = await fetchSeasonRecord(ctx.conn, n);
    if (rec) out.push(...seasonFacts(rec));
  }
  return out;
}

/**
 * Job: tells the app server about Matches that are Delayed or refunded, an opponent's Block Puzzle run, Offers made and
 * accepted, Debt cleared and Season prizes, so it can email the Players (and calls its daily digest once a day).
 * The server holds the once-only record per fact; `told` just stops this process asking again. Each source is
 * read once per pass and one failing source does not stop the others.
 */
export async function notifyEventsJob(ctx: Ctx, env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<number> {
  const base = env.NOTIFY_URL;
  const secret = env.NOTIFY_SECRET;
  if (!base || !secret) return 0;
  const eventsUrl = new URL("events", base).toString();
  const facts: Fact[] = [];
  for (const [name, source] of [["matches", matchesFacts], ["backing", backingFacts], ["positions", positionFacts], ["season", seasonPaidFacts]] as const) {
    try {
      facts.push(...(await source(ctx)));
    } catch (e) {
      log("notify", name, `ERROR ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
  }
  const events: { key: string; body: object }[] = [];
  for (const { account, ...fact } of facts) {
    const authority = await authorityOf(ctx, account);
    if (!authority) continue;
    const key = JSON.stringify([account, fact]);
    if (!told.has(key)) events.push({ key, body: { ...fact, authority } });
  }
  let sent = 0;
  for (let i = 0; i < events.length; i += EVENTS_PER_PUSH) {
    const group = events.slice(i, i + EVENTS_PER_PUSH);
    if (await pushEvents(eventsUrl, secret, group.map((e) => e.body), fetchFn)) {
      for (const e of group) told.add(e.key);
      sent += group.length;
      log("notify", "events", `DONE ${group.length} event(s) sent to the app`);
    } else log("notify", "events", "FAIL the app did not take the events, will retry");
  }
  const hour = Number(env.KEEPER_DIGEST_HOUR_UTC ?? 8);
  if (digestDue(Date.now(), digestDay, hour) && (await pushDigest(new URL("digest", base).toString(), secret, fetchFn))) {
    digestDay = new Date().toISOString().slice(0, 10);
    log("notify", "digest", "DONE daily digest sent");
  }
  return sent;
}
