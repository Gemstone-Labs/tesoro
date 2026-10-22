import { POSITION_SPACE } from "../../app/src/lib/chain/position-size.ts";
import { delayedOf } from "../../app/src/lib/chain/match-status.ts";
import { rankTotal, readSeason, seasonsToCheck, type SeasonRecord } from "./season.ts";
import { matchKeyOf } from "../../app/src/server/history/match-key.ts";
import { viewOf } from "./settle.ts";
import { PublicKey } from "@solana/web3.js";
import { log, type Ctx } from "./act.ts";
import { gameOfKey, postToApp, type GameId, type PushResult } from "./notify.ts";
import { pk } from "./runtime.ts";

/** One fact for a Player's Account (`account` is a TesoroAccount key); the job turns it into the app's wire event with the wallet authority. */
export type Fact = { account: string } & (
  | { kind: "match-delayed"; matchId: string; game: GameId; refundBy: number; refundOpen: boolean }
  | { kind: "match-refunded"; matchId: string; game: GameId; entry: number }
  | { kind: "offer-made"; offerId: string; game: GameId; entry: number }
  | { kind: "offer-accepted"; offerId: string; game: GameId; entry: number }
  | { kind: "debt-cleared"; positionId: string; advance: number; asset: string }
  | { kind: "season-placed"; season: number; rank: number; gemas: number }
);

/** Matches whose refund deadline passed longer ago than this are not announced (a restart does not replay old history). */
const WINDOW_SECS = 3 * 24 * 3600;
/** Block Burst Matches whose Session and Boards are read per pass. */
const EVENTS_PER_PUSH = 50;

export interface MatchFacts {
  /** The Match's id as the app shows it: `<opener>-<n>`. */
  id: bigint | string;
  game: GameId;
  status: "open" | "active" | "settled" | "refunded";
  /** tesoro_core's refund deadline, unix seconds. */
  deadline: number;
  entry: number;
  /** TesoroAccount keys of the Players. */
  players: string[];
}

/** Refunded and Delayed Matches, for each Player. Delayed follows match-status's rule, so it agrees with the app. */
export function matchFacts(m: MatchFacts, nowSecs: number): Fact[] {
  if (nowSecs - m.deadline > WINDOW_SECS) return [];
  const matchId = m.id.toString();
  if (m.status === "refunded") return m.players.map((account) => ({ account, kind: "match-refunded", matchId, game: m.game, entry: m.entry }));
  const late = delayedOf({ status: m.status, game: m.game, deadline: m.deadline }, nowSecs);
  if (!late) return [];
  return m.players.map((account) => ({ account, kind: "match-delayed", matchId, game: m.game, refundBy: m.deadline, refundOpen: late.refundOpen }));
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
  /** The Request this Offer answers. */
  request: string;
}

/** An open Offer made on a Request tells the Request's Player; an accepted Offer (still to be used) tells its Backer. */
export function offerFacts(offers: OfferFacts[], requestPlayer: Map<string, string>, nowSecs: number): Fact[] {
  const out: Fact[] = [];
  for (const o of offers) {
    if (o.status === "open" && nowSecs < o.expiresAt) {
      const player = requestPlayer.get(o.request);
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

/** Each rank of a Season that has been paid in full (every budget line). */
export function seasonFacts(rec: { number: number; count: number; winners: string[]; gemas: bigint[]; paid: boolean[] }): Fact[] {
  const out: Fact[] = [];
  for (let i = 0; i < rec.count; i++) {
    if (rec.paid[i]) out.push({ account: rec.winners[i], kind: "season-placed", season: rec.number, rank: i + 1, gemas: Number(rec.gemas[i]) });
  }
  return out;
}

/** A recorded Season in the shape `seasonFacts` takes. */
export const seasonFactsInput = (r: SeasonRecord) => ({
  number: r.number,
  count: r.count,
  winners: r.winners.map((w) => w.toBase58()),
  gemas: r.winners.map((_, i) => rankTotal(r, i)),
  paid: r.winners.map((_, i) => r.lines.length > 0 && r.cursor[i] === r.lines.length),
});

/** The daily digest is due from `hourUtc` on, once per UTC day. */
export function digestDue(nowMs: number, lastDay: string | null, hourUtc: number): boolean {
  const d = new Date(nowMs);
  return d.getUTCHours() >= hourUtc && d.toISOString().slice(0, 10) !== lastDay;
}

export const pushEvents = (url: string, secret: string, events: object[], fetchFn: typeof fetch = fetch): Promise<PushResult> => postToApp(url, secret, { events }, fetchFn);
/** True when the server ran the digest. */
export const pushDigest = async (url: string, secret: string, fetchFn: typeof fetch = fetch) => (await postToApp(url, secret, {}, fetchFn)) === "sent";

/**
 * Sends events in groups and records each one the app is done with in `told`. The app refuses a whole group when one
 * event in it is malformed (a Game it does not list yet), so a refused group is sent again one event at a time and
 * only the refused events are dropped. Returns how many the app took.
 */
export async function sendEvents(url: string, secret: string, events: { key: string; body: object }[], told: Set<string>, fetchFn: typeof fetch = fetch): Promise<number> {
  let sent = 0;
  for (let i = 0; i < events.length; i += EVENTS_PER_PUSH) {
    const group = events.slice(i, i + EVENTS_PER_PUSH);
    const res = await pushEvents(url, secret, group.map((e) => e.body), fetchFn);
    if (res === "sent") {
      for (const e of group) told.add(e.key);
      sent += group.length;
      log("notify", "events", `DONE ${group.length} event(s) sent to the app`);
    } else if (res === "rejected") {
      for (const e of group) {
        const one = group.length === 1 ? res : await pushEvents(url, secret, [e.body], fetchFn);
        if (one === "failed") continue;
        told.add(e.key);
        if (one === "sent") sent++;
        else log("notify", "events", `SKIP the app does not take this event: ${JSON.stringify(e.body).slice(0, 120)}`);
      }
    } else log("notify", "events", "FAIL the app did not take the events, will retry");
  }
  return sent;
}

const told = new Set<string>();
const authorities = new Map<string, string>();
let owed: Map<string, number> | null = null;
let digestDay: string | null = null;

const status = (o: object) => Object.keys(o)[0];
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
  for (const { publicKey, account } of all) {
    const view = viewOf(publicKey, account);
    const game = gameOfKey(pk(account.inner.game));
    // Open and Active Matches can be Delayed; a Refunding one is being refunded; the rest (settling, closed) say nothing.
    if (!game || (view.stage !== "open" && view.stage !== "active" && view.stage !== "refunding")) continue;
    const st: MatchFacts["status"] = view.stage === "refunding" ? "refunded" : view.stage;
    if (st === "open") continue;
    const m = account.inner;
    const label = matchKeyOf({ opener: view.ref.opener.toBase58(), n: view.ref.n });
    const players = [m.a, m.b].filter(Boolean).map((s: any) => pk(s.player).toBase58());
    const base = { id: label, game, status: st, deadline: Number(m.deadline.toString()), entry: Number(m.entry.toString()), players };
    facts.push(...matchFacts(base, ctx.now));
  }
  return facts;
}

async function backingFacts(ctx: Ctx): Promise<Fact[]> {
  const [requests, offers]: any[][] = await Promise.all([ctx.core.account.requestState.all(), ctx.core.account.offerState.all()]);
  const requestPlayer = new Map<string, string>(requests.map((r) => [(r.publicKey as PublicKey).toBase58(), pk(r.account.inner.player).toBase58()]));
  const rows: OfferFacts[] = offers.flatMap(({ publicKey, account }) => {
    const o = account.inner;
    const game = gameOfKey(pk(o.game));
    return game
      ? [{ address: (publicKey as PublicKey).toBase58(), backer: pk(o.backer).toBase58(), game, entry: Number(o.entry.toString()), status: status(o.status), expiresAt: Number(o.expiresAt.toString()), useBy: Number(o.useBy.toString()), request: pk(o.request).toBase58() }]
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
    const rec = await readSeason(ctx.core, n);
    if (rec) out.push(...seasonFacts(seasonFactsInput(rec)));
  }
  return out;
}

/**
 * Job: tells the app server about Matches that are Delayed or refunded, an opponent's Block Burst run, Offers made and
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
  const sent = await sendEvents(eventsUrl, secret, events, told, fetchFn);
  const hour = Number(env.KEEPER_DIGEST_HOUR_UTC ?? 8);
  if (digestDue(Date.now(), digestDay, hour) && (await pushDigest(new URL("digest", base).toString(), secret, fetchFn))) {
    digestDay = new Date().toISOString().slice(0, 10);
    log("notify", "digest", "DONE daily digest sent");
  }
  return sent;
}
