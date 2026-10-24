import { matchKeyOf } from "./match-key";
import type { MatchRecord, MatchRunStartedRecord } from "./events";
import type { Rpc } from "./rpc";

/** What the keeper reads from the Game's own account (the Block Burst Session); core's records do not carry it. */
export interface MatchDetail {
  /** Block Burst only: [side A score, side B score]. */
  scores?: [number, number] | null;
}

export interface IngestContext {
  /** Required for immutable Source-line records. Confirmed forks must never enter this stream. */
  finalized?: boolean;
  signature?: string;
  slot?: number;
  /** The id the app uses for a Game program ("holdem", "trading-duel", ...); null for a program it does not know. */
  gameOf: (program: string) => string | null;
  /** Called once per Match with a start record. */
  detail?: (matchKey: string) => MatchDetail | undefined;
}

type Party = { account: string; role: "player" | "backer"; side: 0 | 1; result: "won" | "lost" | "draw" | "no-show" | "refunded"; delta: number; delta_exact: string; backing_other: string | null; share_bps: number | null };

/**
 * Each side's Player, and the Backer who funded it, with the result and Gema change after Fees. The rule
 * of `backedSplit` in lib/chain/ledger.ts: the surplus is the loser's entry minus Fees, the Player takes
 * their share of it and the Backer the rest; a backed loss costs the Player 0 and the Backer the entry.
 * Draws and refunds move 0, except a no-show: each side pays the Platform Fee, the Backer's when the entry is backed.
 */
export function partiesOf(s: MatchRunStartedRecord): Party[] {
  const shares = [s.aShareBps, s.bShareBps];
  const entry = BigInt(s.entryExact ?? s.entry);
  const feeUnits = (s.feesExact ?? s.fees).map((v) => BigInt(v));
  const noShowFee = s.kind === 1 ? feeUnits[0] / 2n : 0n;
  const sides = [
    { player: s.aPlayer, funder: s.aFunder },
    ...(s.bPlayer ? [{ player: s.bPlayer, funder: s.bFunder ?? s.bPlayer }] : []),
  ];
  const fees = feeUnits[0] + feeUnits[1] + feeUnits[2];
  const out: Party[] = [];
  sides.forEach((side, i) => {
    const seat = i as 0 | 1;
    const result: Party["result"] = s.kind === 0 ? (s.winnerSide === seat ? "won" : "lost") : s.kind === 2 ? "draw" : s.kind === 1 ? "no-show" : "refunded";
    const backed = side.funder !== side.player;
    const surplus = entry - fees;
    const playerShare = surplus * BigInt(shares[seat]) / 10_000n;
    const gain = result === "won" ? (backed ? [playerShare, surplus - playerShare] : [entry - fees, 0n]) : [0n, 0n];
    const loss = result === "lost" ? entry : 0n;
    const playerDelta = result === "won" ? gain[0] : backed ? 0n : -loss - noShowFee;
    out.push({
      account: side.player,
      role: "player",
      side: seat,
      result,
      delta: Number(playerDelta),
      delta_exact: playerDelta.toString(),
      backing_other: backed ? side.funder : null,
      share_bps: backed ? shares[seat] : null,
    });
    if (backed) {
      const delta = result === "won" ? gain[1] : -loss - noShowFee;
      out.push({ account: side.funder, role: "backer", side: seat, result, delta: Number(delta), delta_exact: delta.toString(), backing_other: side.player, share_bps: shares[seat] });
    }
  });
  return out;
}

/** The payload `ingest_match_event` takes for one record, with a stable id so a record is stored once however often it is read. */
export function payloadOf(r: MatchRecord, ctx: IngestContext): Record<string, unknown> {
  const base = { opener: r.opener, n: r.n.toString(), signature: ctx.signature ?? null, slot: ctx.slot ?? null, core_event: r.coreEvent ?? null, finalized: ctx.finalized === true };
  const id = matchKeyOf(r);
  switch (r.type) {
    case "start": {
      const d = ctx.detail?.(id);
      return {
        ...base,
        type: "start",
        event_id: `${id}:start`,
        game: ctx.gameOf(r.game) ?? r.game,
        entry: r.entry,
        entry_exact: r.entryExact ?? String(r.entry),
        fees_exact: r.feesExact ?? r.fees.map(String),
        kind: r.kind,
        winner_side: r.winnerSide,
        fees: r.fees,
        a_player: r.aPlayer,
        a_funder: r.aFunder,
        b_player: r.bPlayer,
        b_funder: r.bFunder,
        challenge: r.challenge,
        asset: r.asset,
        opened_at: r.openedAt,
        ts: r.ts,
        scores: d?.scores ?? null,
        parties: partiesOf(r),
      };
    }
    case "won":
      return { ...base, type: "won", event_id: `${id}:won`, game: ctx.gameOf(r.game) ?? r.game, entry: r.entry, entry_exact: r.entryExact ?? String(r.entry), winner: r.winner, loser: r.loser, points: r.points, pool_fee: r.poolFee, pool_fee_exact: r.poolFeeExact ?? String(r.poolFee), season: r.season, ts: r.ts, challenge: r.challenge, asset: r.asset, opened_at: r.openedAt };
    case "chunk":
      return { ...base, type: "chunk", event_id: `${id}:chunk:${r.chunkNo}`, chunk_no: r.chunkNo };
    case "settled":
      return { ...base, type: "settled", event_id: `${id}:settled`, kind: r.kind, chunks: r.chunks, ts: Math.floor(Date.now() / 1000) };
    case "lines-start":
      return { ...base, type: r.type, version: r.version, event_id: "manifest", pot_lines: r.potLines, studio_owner: r.studioOwner, studio_priority: r.studioPriority, finalized: ctx.finalized === true };
    case "line-step":
      return { ...base, type: r.type, version: r.version, event_id: `step:${r.step}`, chunk_no: r.chunkNo, step: r.step,
        pot_side: r.potSide, pot_index: r.potIndex, purpose: r.purpose, incoming: r.incoming, outgoing: r.outgoing,
        recipient_kind: r.recipientKind, recipient: r.recipient, placement: r.placement, finalized: ctx.finalized === true };
    case "lines-progress":
      return { ...base, type: r.type, version: r.version, event_id: `progress:${r.chunkNo}`, chunk_no: r.chunkNo,
        cumulative_steps: r.cumulativeSteps, done: r.done, finalized: ctx.finalized === true };
  }
}

/**
 * Stores the Match records of one transaction. Safe to repeat and to call out of order. Returns how many
 * were new. `settled` carries no time on chain, so the ingest time stands in; pass `blockTime` to use the chain's.
 */
export async function ingestMatchRecords(rpc: Rpc, records: MatchRecord[], ctx: IngestContext & { blockTime?: number }): Promise<number> {
  const isLineRecord = (r: MatchRecord) => r.type === "lines-start" || r.type === "line-step" || r.type === "lines-progress";
  // Validate the whole transaction before a first-wins legacy header can be stored.
  if (!ctx.finalized && records.some(isLineRecord)) throw new Error("Source-line records require finalized transactions");
  let added = 0;
  for (const r of records) {
    const p = payloadOf(r, ctx);
    const lineRecord = isLineRecord(r);
    if (r.type === "settled" && ctx.blockTime !== undefined) p.ts = ctx.blockTime;
    if (await rpc(lineRecord ? "ingest_match_line_event" : "ingest_match_event", { p })) added += 1;
  }
  return added;
}
