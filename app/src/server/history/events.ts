import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";

const CORE = new PublicKey((coreIdl as { address: string }).address);
const EVENT_AUTHORITY = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], CORE)[0].toBase58();
/** Anchor's event-CPI instruction tag: the first 8 bytes of the data of the self-call that carries an event. */
const EVENT_TAG = Buffer.from("e445a52e51cb9a1d", "hex");
/** Decoded event fields keep the IDL's snake_case names. */
const coder = new anchor.BorshEventCoder(coreIdl as anchor.Idl);

/** An instruction run inside a transaction, as its account keys and data. */
export interface InnerInstruction {
  programId: string;
  accounts: string[];
  data: Uint8Array;
}

const key = (v: unknown) => new PublicKey(v as PublicKey).toBase58();
const num = (v: unknown) => Number((v as { toString(): string }).toString());

export interface MatchRunStartedRecord {
  type: "start";
  opener: string;
  n: bigint;
  game: string;
  /** 0 win, 1 no-show, 2 draw, 3 cancelled, 4 abandoned, 5 game upgraded, 6 refunded by game. */
  kind: number;
  /** 0 opened, 1 joined; null when there is none. */
  winnerSide: 0 | 1 | null;
  entry: number;
  /** Gemas taken from the Pot: Platform, Studio, Leaderboard. */
  fees: [number, number, number];
  aPlayer: string;
  aFunder: string;
  bPlayer: string | null;
  bFunder: string | null;
  challenge: boolean;
  asset: number;
  openedAt: number;
  ts: number;
  /** Each side's Player share of a Backing, in bps (0 for an unbacked side). */
  aShareBps: number;
  bShareBps: number;
}
export interface MatchWonRecord {
  type: "won";
  opener: string;
  n: bigint;
  game: string;
  entry: number;
  winner: string;
  funder: string;
  loser: string;
  points: number;
  poolFee: number;
  season: number;
  ts: number;
  challenge: boolean;
  asset: number;
  openedAt: number;
}
export interface MatchChunkRecord {
  type: "chunk";
  opener: string;
  n: bigint;
  chunkNo: number;
  steps: number;
  done: boolean;
  blocked: boolean;
}
export interface MatchSettledRecord {
  type: "settled";
  opener: string;
  n: bigint;
  kind: number;
  chunks: number;
}
export type MatchRecord = MatchRunStartedRecord | MatchWonRecord | MatchChunkRecord | MatchSettledRecord;

const ZERO = PublicKey.default.toBase58();
const opt = (k: string) => (k === ZERO ? null : k);

function toRecord(name: string, d: any): MatchRecord | null {
  const id = { opener: key(d.opener), n: BigInt(d.n.toString()) };
  switch (name) {
    case "MatchRunStarted":
      return {
        type: "start",
        ...id,
        game: key(d.game),
        kind: d.kind,
        winnerSide: d.winner === 0 || d.winner === 1 ? d.winner : null,
        entry: num(d.entry),
        fees: [num(d.fees[0]), num(d.fees[1]), num(d.fees[2])],
        aPlayer: key(d.a_player),
        aFunder: key(d.a_funder),
        bPlayer: opt(key(d.b_player)),
        bFunder: opt(key(d.b_funder)),
        challenge: d.challenge,
        asset: d.asset,
        openedAt: num(d.opened_at),
        ts: num(d.ts),
        aShareBps: d.a_share_bps,
        bShareBps: d.b_share_bps,
      };
    case "MatchWon":
      return {
        type: "won",
        ...id,
        game: key(d.game),
        entry: num(d.entry),
        winner: key(d.player),
        funder: key(d.funder),
        loser: key(d.loser),
        points: num(d.points),
        poolFee: num(d.pool_fee),
        season: d.season,
        ts: num(d.ts),
        challenge: d.challenge,
        asset: d.asset,
        openedAt: num(d.opened_at),
      };
    case "MatchChunkDone":
      return { type: "chunk", ...id, chunkNo: d.chunk_no, steps: d.steps, done: d.done, blocked: d.blocked };
    case "MatchSettled":
      return { type: "settled", ...id, kind: d.kind, chunks: d.chunks };
    default:
      return null;
  }
}

/**
 * The Match records among a transaction's inner instructions. Only an event-CPI that tesoro_core itself
 * issued counts: the instruction's program is tesoro_core and its first account is core's event-authority
 * PDA, which only core can sign for. A log line printed by any other program, or the same bytes sent as
 * another program's instruction, is ignored (the Fake-wins fix of 93e7960, kept for event-CPI).
 */
export function decodeMatchRecords(inner: InnerInstruction[]): MatchRecord[] {
  const out: MatchRecord[] = [];
  for (const ix of inner) {
    if (ix.programId !== CORE.toBase58() || ix.accounts[0] !== EVENT_AUTHORITY) continue;
    const data = Buffer.from(ix.data);
    if (data.length <= 8 || !data.subarray(0, 8).equals(EVENT_TAG)) continue;
    let event;
    try {
      event = coder.decode(data.subarray(8).toString("base64"));
    } catch {
      continue;
    }
    const record = event && toRecord(event.name, event.data);
    if (record) out.push(record);
  }
  return out;
}

/** The inner instructions of a `getTransaction` response (maxSupportedTransactionVersion 0), failed transactions excluded. */
export function innerInstructionsOf(tx: {
  meta: { err: unknown; innerInstructions?: { instructions: { programIdIndex: number; accounts: number[]; data: string }[] }[] | null; loadedAddresses?: { writable: PublicKey[]; readonly: PublicKey[] } } | null;
  transaction: { message: { staticAccountKeys?: PublicKey[]; accountKeys?: PublicKey[] } };
}): InnerInstruction[] {
  if (!tx.meta || tx.meta.err) return [];
  const m = tx.transaction.message;
  const keys = [...(m.staticAccountKeys ?? m.accountKeys ?? []), ...(tx.meta.loadedAddresses?.writable ?? []), ...(tx.meta.loadedAddresses?.readonly ?? [])].map((k) => k.toBase58());
  return (tx.meta.innerInstructions ?? []).flatMap((g) =>
    g.instructions.map((i) => ({ programId: keys[i.programIdIndex], accounts: i.accounts.map((a) => keys[a]), data: bs58.decode(i.data) })),
  );
}
