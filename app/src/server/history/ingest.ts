import { matchKeyOf } from "./match-key";
import type { MatchRecord, MatchRunStartedRecord } from "./events";
import type { Rpc } from "./rpc";

/** What the keeper knows about a Match that the events do not carry; read from MatchState / the Game's account before it closes. */
export interface MatchDetail {
  /** Each side's Player share of a Backing, in bps (0 for an unbacked side). */
  shares?: [number, number];
  /** Block Puzzle only: [side A score, side B score]. */
  scores?: [number, number] | null;
}

export interface IngestContext {
  signature?: string;
  slot?: number;
  /** The id the app uses for a Game program ("holdem", "trading-duel", ...); null for a program it does not know. */
  gameOf: (program: string) => string | null;
  /** Called once per Match with a start record. */
  detail?: (matchKey: string) => MatchDetail | undefined;
}

type Party = { account: string; role: "player" | "backer"; side: 0 | 1; result: "won" | "lost" | "draw" | "refunded"; delta: number; backing_other: string | null; share_bps: number | null };

/**
 * Each side's Player, and the Backer who funded it, with the result and Gema change after Fees. The rule
 * of `backedSplit` in lib/chain/ledger.ts: the surplus is the loser's entry minus Fees, the Player takes
 * their share of it and the Backer the rest; a backed loss costs the Player 0 and the Backer the entry.
 * Draws and every refund move 0 (a no-show's small fee is not shown in history).
 */
export function partiesOf(s: MatchRunStartedRecord, shares: [number, number] = [0, 0]): Party[] {
  const sides = [
    { player: s.aPlayer, funder: s.aFunder },
    ...(s.bPlayer ? [{ player: s.bPlayer, funder: s.bFunder ?? s.bPlayer }] : []),
  ];
  const fees = s.fees[0] + s.fees[1] + s.fees[2];
  const out: Party[] = [];
  sides.forEach((side, i) => {
    const seat = i as 0 | 1;
    const result: Party["result"] = s.kind === 0 ? (s.winnerSide === seat ? "won" : "lost") : s.kind === 2 ? "draw" : "refunded";
    const backed = side.funder !== side.player;
    const surplus = s.entry - fees;
    const playerShare = Math.floor((surplus * shares[seat]) / 10_000);
    const gain = result === "won" ? (backed ? [playerShare, surplus - playerShare] : [s.entry - fees, 0]) : [0, 0];
    const loss = result === "lost" ? s.entry : 0;
    out.push({
      account: side.player,
      role: "player",
      side: seat,
      result,
      delta: result === "won" ? gain[0] : backed ? 0 : -loss,
      backing_other: backed ? side.funder : null,
      share_bps: backed ? shares[seat] : null,
    });
    if (backed) {
      out.push({ account: side.funder, role: "backer", side: seat, result, delta: result === "won" ? gain[1] : -loss, backing_other: side.player, share_bps: shares[seat] });
    }
  });
  return out;
}

/** The payload `ingest_match_event` takes for one record, with a stable id so a record is stored once however often it is read. */
export function payloadOf(r: MatchRecord, ctx: IngestContext): Record<string, unknown> {
  const base = { opener: r.opener, n: r.n.toString(), signature: ctx.signature ?? null, slot: ctx.slot ?? null };
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
        parties: partiesOf(r, d?.shares),
      };
    }
    case "won":
      return { ...base, type: "won", event_id: `${id}:won`, game: ctx.gameOf(r.game) ?? r.game, entry: r.entry, winner: r.winner, loser: r.loser, points: r.points, pool_fee: r.poolFee, season: r.season, ts: r.ts, challenge: r.challenge, asset: r.asset, opened_at: r.openedAt };
    case "chunk":
      return { ...base, type: "chunk", event_id: `${id}:chunk:${r.chunkNo}`, chunk_no: r.chunkNo };
    case "settled":
      return { ...base, type: "settled", event_id: `${id}:settled`, kind: r.kind, chunks: r.chunks, ts: Math.floor(Date.now() / 1000) };
  }
}

/**
 * Stores the Match records of one transaction. Safe to repeat and to call out of order. Returns how many
 * were new. `settled` carries no time on chain, so the ingest time stands in; pass `blockTime` to use the chain's.
 */
export async function ingestMatchRecords(rpc: Rpc, records: MatchRecord[], ctx: IngestContext & { blockTime?: number }): Promise<number> {
  let added = 0;
  for (const r of records) {
    const p = payloadOf(r, ctx);
    if (r.type === "settled" && ctx.blockTime !== undefined) p.ts = ctx.blockTime;
    if (await rpc("ingest_match_event", { p })) added += 1;
  }
  return added;
}
