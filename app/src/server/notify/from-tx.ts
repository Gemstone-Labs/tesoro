import { PublicKey } from "@solana/web3.js";
import { gameOfProgram } from "../../lib/chain/games";
import type { GameId } from "@/lib/mock/types";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import { decodeCoreEvents } from "../history/events";
import { innerOfRawTx, recordsOfRawTx, type RawTx } from "../history/webhook";
import { matchKeyOf } from "../history/match-key";
import { partiesOf } from "../history/ingest";
import type { MatchRunStartedRecord } from "../history/events";
import type { NotifyEvent } from "./decide";
import { CORE_WINDOW_SECS } from "../../lib/chain/match-status";
import { coreInstructionsOf, type CoreInstruction } from "./core-ix";
import type { MatchPlayer, OpenMatchStore } from "./open-match";

const CORE = new PublicKey((coreIdl as { address: string }).address);

/** tesoro_core's `["match", opener Account, counter as u64 LE]`. */
export function matchStateOf(opener: string, n: bigint): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64LE(n);
  return PublicKey.findProgramAddressSync([Buffer.from("match"), new PublicKey(opener).toBuffer(), counter], CORE)[0].toBase58();
}

/** What the notifications need to read from the chain when a transaction does not say it. */
export interface NotifyChain {
  /** The wallet that controls a TesoroAccount; null when it cannot be read. */
  authorityOfAccount(account: string): Promise<string | null>;
  request(address: string): Promise<{ player: string; game: GameId; entry: number } | null>;
  offer(address: string): Promise<{ backer: string; request: string; game: GameId; entry: number } | null>;
  position(address: string): Promise<{ owner: string; asset: string } | null>;
}

export interface TxDeps {
  matches: OpenMatchStore;
  chain: NotifyChain;
}

/** Start-record kinds that end a Match without a result: cancelled, abandoned, game upgraded, refunded by the game. */
const REFUND_KINDS = [3, 4, 5, 6];

async function playersOf(start: MatchRunStartedRecord, deps: TxDeps): Promise<Map<string, string>> {
  const known = new Map<string, string>();
  const row = await deps.matches.get(matchStateOf(start.opener, start.n));
  for (const p of row?.players ?? []) known.set(p.account, p.authority);
  for (const account of [start.aPlayer, start.bPlayer]) {
    if (!account || known.has(account)) continue;
    const authority = await deps.chain.authorityOfAccount(account);
    if (authority) known.set(account, authority);
  }
  return known;
}

async function eventsOfStart(start: MatchRunStartedRecord, deps: TxDeps): Promise<NotifyEvent[]> {
  const game = gameOfProgram(new PublicKey(start.game));
  const settled = start.kind === 0 || start.kind === 2;
  if (!game || (!settled && !REFUND_KINDS.includes(start.kind))) return [];
  const authorities = await playersOf(start, deps);
  const matchId = matchKeyOf(start);
  const events: NotifyEvent[] = [];
  for (const p of partiesOf(start)) {
    const authority = authorities.get(p.account);
    if (p.role !== "player" || !authority) continue;
    if (settled) {
      const result = p.result as "won" | "lost" | "draw";
      events.push({ kind: "match-settled", id: `match-settled:${matchId}:${authority}`, authority, matchId, game, result, gemas: Math.abs(p.delta), pot: start.entry * 2 });
    } else events.push({ kind: "match-refunded", id: `match-refunded:${matchId}:${authority}`, authority, matchId, game, entry: start.entry });
  }
  return events;
}

/** Keeps the open-Match table in step with the Match instructions of a transaction. */
async function trackMatch(ix: CoreInstruction, tx: RawTx, deps: TxDeps): Promise<void> {
  const player = (): MatchPlayer | null => {
    const account = ix.account("player_account");
    const authority = ix.account("player_authority");
    return account && authority ? { account, authority } : null;
  };
  const matchState = ix.account("match_state");
  if (!matchState) return;
  if (ix.name === "open_match") {
    const opener = player();
    const game = gameOfProgram(new PublicKey(ix.data.subarray(0, 32)));
    if (!opener || !game) return;
    const entry = Number(ix.data.readBigUInt64LE(32));
    const n = ix.data.readBigUInt64LE(40);
    await deps.matches.open({ matchState, matchKey: matchKeyOf({ opener: opener.account, n }), game, entry, opener });
  } else if (ix.name === "join_match") {
    const joiner = player();
    if (joiner && tx.blockTime) await deps.matches.join(matchState, joiner, tx.blockTime + CORE_WINDOW_SECS);
  } else if (ix.name === "extend_match_deadline") {
    await deps.matches.extend(matchState, Number(ix.data.readBigInt64LE(0)));
  }
}

const CORE_ID = CORE.toBase58();

/** Offer events: made (to the Request's Player) and accepted (to the Backer). */
async function eventsOfOffer(ix: CoreInstruction, deps: TxDeps): Promise<NotifyEvent[]> {
  const offerId = ix.account("offer");
  const offer = offerId ? await deps.chain.offer(offerId) : null;
  if (!offerId || !offer) return [];
  if (ix.name === "accept_offer") {
    const authority = await deps.chain.authorityOfAccount(offer.backer);
    return authority ? [{ kind: "offer-accepted", id: `offer-accepted:${offerId}:${authority}`, authority, offerId, game: offer.game, entry: offer.entry }] : [];
  }
  const request = await deps.chain.request(offer.request);
  const authority = request && (await deps.chain.authorityOfAccount(request.player));
  return authority ? [{ kind: "offer-made", id: `offer-made:${offerId}:${authority}`, authority, offerId, game: offer.game, entry: offer.entry }] : [];
}

/**
 * Debt cleared: yield applied to a Position with an open Advance (a Source is given) that leaves nothing to pay back. With no
 * Advance open core is given its own id for the Source and reports a Debt of 0 too, which is not an event.
 */
async function eventsOfYield(tx: RawTx, instructions: CoreInstruction[], deps: TxDeps): Promise<NotifyEvent[]> {
  const withSource = new Set(instructions.filter((i) => (i.name === "apply_yield" || i.name === "apply_yield_from_source") && i.account("source") !== CORE_ID).map((i) => i.account("position")));
  const events: NotifyEvent[] = [];
  for (const e of decodeCoreEvents(innerOfRawTx(tx), ["YieldApplied"])) {
    const position = new PublicKey(e.data.position).toBase58();
    if (Number(e.data.debt_gemas) !== 0 || !withSource.has(position)) continue;
    const found = await deps.chain.position(position);
    const authority = found && (await deps.chain.authorityOfAccount(found.owner));
    if (found?.asset && authority) events.push({ kind: "debt-cleared", id: `debt-cleared:${position}:${e.data.seq.toString()}`, authority, positionId: position, asset: found.asset });
  }
  return events;
}

/**
 * What one stored transaction means for notifications. Keeps the open-Match table up to date (always) and returns the events
 * to email (only with `emails`, which also saves the chain reads they need). Safe to run twice on the same transaction.
 */
export async function processTx(tx: RawTx, deps: TxDeps, opts: { emails: boolean }): Promise<NotifyEvent[]> {
  const events: NotifyEvent[] = [];
  const instructions = coreInstructionsOf(tx);
  for (const ix of instructions) {
    await trackMatch(ix, tx, deps);
    if (opts.emails && (ix.name === "create_offer" || ix.name === "accept_offer")) events.push(...(await eventsOfOffer(ix, deps)));
  }
  if (opts.emails) events.push(...(await eventsOfYield(tx, instructions, deps)));
  for (const record of recordsOfRawTx(tx)) {
    if (record.type !== "start") continue;
    if (opts.emails) events.push(...(await eventsOfStart(record, deps)));
    await deps.matches.close(matchStateOf(record.opener, record.n));
  }
  return events;
}
export type { MatchPlayer };
