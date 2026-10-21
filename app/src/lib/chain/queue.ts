import { TxFailedError, TxUnconfirmedError, type TxOutcome } from "../../games/block-puzzle/tx";
import type { GameId } from "@/lib/mock/types";
import { assetIndexOf } from "./match-id";
import type { ChainMatch } from "./read";

/**
 * Queue entry, independent of RPC so it can be tested with stubbed sends.
 *
 * A send that timed out may still land, so it is settled on chain before anything else happens.
 * Only a definite failure moves on to the next Match; anything unclassified stops, so a Player is
 * never left in one Match while the app opens a second.
 */
/** One side of a Match as tesoro_core compares them: TesoroAccount keys of who plays and who pays the entry. */
export interface SideKeys {
  player: string;
  funder: string;
}

/**
 * Whether `entrant` may take the open seat against `seat`. tesoro_core's `join` refuses it (SelfMatch) for the same
 * Player, the same funder, or the opener's own Backer, so a Backer never plays the Player they fund.
 */
export function canJoinSeat(seat: SideKeys, entrant: SideKeys): boolean {
  return entrant.player !== seat.player && entrant.funder !== seat.funder && entrant.player !== seat.funder;
}

export interface QueueDeps {
  game: GameId;
  entry: number;
  /** Trading Duel: the asset index (0 SOL, 1 ETH, 2 HYPE) this Queue is for. Other Games ignore it. */
  asset?: number;
  /** Who enters and who pays: seats tesoro_core would refuse to this pair are skipped. */
  entrant?: SideKeys;
  /** Open Queue Match ids at this entry, oldest first. A list read: it may lag the chain. */
  listCandidates(): Promise<bigint[]>;
  /** Fresh read of one Match as this Account sees it. */
  readMatch(id: bigint): Promise<ChainMatch | null>;
  join(id: bigint): Promise<unknown>;
  open(id: bigint): Promise<unknown>;
  /** Settles a send that threw `TxUnconfirmedError`. */
  settle(e: TxUnconfirmedError): Promise<TxOutcome>;
  /** Matches of this game the Player is seated in and still has to play, read fresh. */
  unfinished(): Promise<ChainMatch[]>;
  newId(): bigint;
  /** After a definite failure: false when the entry itself can no longer be used (a spent Offer). */
  canRetry?(): Promise<boolean>;
  onStep?(s: string): void;
  now?(): number;
}

export interface Entered {
  id: bigint;
  /** "existing": the Player still has this Match to play, so nothing new was entered. */
  via: "joined" | "opened" | "existing";
}

/** A send whose fate could not be settled. Entering anything else could leave the Player in two Matches. */
export class QueueUnconfirmedError extends Error {
  constructor(
    readonly matchId: bigint,
    cause: unknown,
  ) {
    super("Your entry was sent but Solana has not confirmed it yet. Check Continue in the Lobby in a minute before entering again.", { cause });
  }
}

export type SendResult = "landed" | "failed" | "unknown";

/** Classifies a send that threw. `seated` tells whether the fresh Match shows the send took effect. */
export async function classifySend(d: Pick<QueueDeps, "readMatch" | "settle">, e: unknown, id: bigint, seated: (m: ChainMatch) => boolean): Promise<SendResult> {
  if (e instanceof TxFailedError) return "failed";
  if (!(e instanceof TxUnconfirmedError)) return "unknown";
  const tx = await d.settle(e);
  if (tx === "landed" || tx === "failed") return tx;
  const m = await d.readMatch(id).catch(() => undefined);
  if (m && seated(m)) return "landed";
  return tx === "expired" && m !== undefined ? "failed" : "unknown";
}

const READS_PER_ROUND = 6;
/** findQueue skips Matches this close to their refund deadline. */
const MIN_LEFT_SECS = 60;

function joinable(d: QueueDeps, m: ChainMatch, now: number): boolean {
  return (
    m.status === "open" &&
    m.game === d.game &&
    m.entry === d.entry &&
    !m.challenge &&
    m.seat === null &&
    m.backerSeat === null &&
    m.deadline > now + MIN_LEFT_SECS &&
    (!d.entrant || !m.sides[0] || canJoinSeat(m.sides[0], d.entrant)) &&
    // Block Puzzle: only Matches opened with their Session (this version of the app) can be joined.
    (d.game !== "block-puzzle" || m.session !== null) &&
    // Trading Duel: the Queue is per asset, which the Match id carries.
    (d.game !== "trading-duel" || d.asset === undefined || assetIndexOf(m.id) === d.asset)
  );
}

/** The oldest listed Match not tried yet that a fresh read still shows as joinable. */
async function nextCandidate(d: QueueDeps, tried: Set<bigint>): Promise<bigint | null> {
  const ids = (await d.listCandidates()).filter((id) => !tried.has(id)).slice(0, READS_PER_ROUND);
  const now = Math.floor((d.now?.() ?? Date.now()) / 1000);
  for (const id of ids) {
    const m = await d.readMatch(id);
    if (m && joinable(d, m, now)) return id;
    tried.add(id);
  }
  return null;
}

/** Queue: join the oldest open Match at this entry from another Account, else open one. */
export async function queueEntry(d: QueueDeps): Promise<Entered> {
  const step = d.onStep ?? (() => undefined);
  const existing = async () => (await d.unfinished())[0] ?? null;

  const before = await existing();
  if (before) return { id: before.id, via: "existing" };

  const tried = new Set<bigint>();
  for (let attempt = 0; attempt < 3; attempt++) {
    step("Looking for an opponent…");
    const id = await nextCandidate(d, tried);
    if (id === null) break;
    tried.add(id);
    step("Joining a Match…");
    try {
      await d.join(id);
      return { id, via: "joined" };
    } catch (e) {
      if (e instanceof TxUnconfirmedError) step("Confirming your entry on Solana…");
      const r = await classifySend(d, e, id, (m) => m.seat !== null);
      if (r === "landed") return { id, via: "joined" };
      if (r === "unknown") throw e instanceof TxUnconfirmedError ? new QueueUnconfirmedError(id, e) : e;
      if (d.canRetry && !(await d.canRetry())) throw e;
    }
  }

  const after = await existing();
  if (after) return { id: after.id, via: "existing" };

  step("Opening a Match…");
  const id = d.newId();
  try {
    await d.open(id);
  } catch (e) {
    if (e instanceof TxUnconfirmedError) step("Confirming your entry on Solana…");
    const r = await classifySend(d, e, id, (m) => m.seat === 0);
    if (r === "unknown" && e instanceof TxUnconfirmedError) throw new QueueUnconfirmedError(id, e);
    if (r !== "landed") throw e;
  }
  return { id, via: "opened" };
}
