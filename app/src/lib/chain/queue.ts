import { TxFailedError, TxUnconfirmedError, type TxOutcome } from "../../games/block-puzzle/tx";
import type { GameId } from "@/lib/mock/types";
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
  /** Open Queue Match keys at this entry, oldest first. A list read: it may lag the chain. */
  listCandidates(): Promise<string[]>;
  /** Fresh read of one Match as this Account sees it. */
  readMatch(id: string): Promise<ChainMatch | null>;
  join(id: string): Promise<unknown>;
  open(id: string): Promise<unknown>;
  /** Settles a send that threw `TxUnconfirmedError`. */
  settle(e: TxUnconfirmedError): Promise<TxOutcome>;
  /** Matches of this game the Player is seated in and still has to play, read fresh. */
  unfinished(): Promise<ChainMatch[]>;
  /** The key of the Match `open` is about to create (`<opener>-<n>` from the opener's counter). */
  newId(): string | Promise<string>;
  /** After a definite failure: false when the entry itself can no longer be used (a spent Offer). */
  canRetry?(): Promise<boolean>;
  onStep?(s: string): void;
  now?(): number;
}

export interface Entered {
  /** The Match key. */
  id: string;
  /** "existing": the Player still has this Match to play, so nothing new was entered. */
  via: "joined" | "opened" | "existing";
}

/** A send whose fate could not be settled. Entering anything else could leave the Player in two Matches. */
export class QueueUnconfirmedError extends Error {
  constructor(
    readonly matchId: string,
    cause: unknown,
  ) {
    super("Your entry was sent but Solana has not confirmed it yet. Check Continue in the Lobby in a minute before entering again.", { cause });
  }
}

export type SendResult = "landed" | "failed" | "unknown";

/** Classifies a send that threw. `seated` tells whether the fresh Match shows the send took effect. */
export async function classifySend(d: Pick<QueueDeps, "readMatch" | "settle">, e: unknown, id: string, seated: (m: ChainMatch) => boolean): Promise<SendResult> {
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
    // Trading Duel: the Queue is per asset, which the Match records (`meta.asset`).
    (d.game !== "trading-duel" || d.asset === undefined || m.asset === d.asset)
  );
}

/** The oldest listed Match not tried yet that a fresh read still shows as joinable. */
async function nextCandidate(d: QueueDeps, tried: Set<string>): Promise<string | null> {
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

  const tried = new Set<string>();
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
  const id = await d.newId();
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

/** What `mergeQueue` needs beyond a Queue entry: the way out of the Player's own waiting Match. */
export interface MergeDeps extends QueueDeps {
  /** Cancels the Player's own unjoined Match (opener refund). The Match then refunds in steps: it stays unfinished until they are done. */
  refund(id: string): Promise<unknown>;
  /** Waits `ms` (tests make it instant). */
  pause?(ms: number): Promise<void>;
}

export type Merged = { moved: false } | { moved: true; entered: Entered };

/**
 * Queue order, oldest first: when the Match opened, then the Match key. Every page sorts the same way, so for any two
 * waiting openers exactly one is younger.
 */
export const isOlder = (a: Pick<ChainMatch, "openedAt" | "id">, b: Pick<ChainMatch, "openedAt" | "id">): boolean => a.openedAt < b.openedAt || (a.openedAt === b.openedAt && a.id < b.id);

/** A Match that is the Player's own, unjoined, unbacked Queue Match: the only kind that may move. */
export const canMove = (m: ChainMatch): boolean => m.status === "open" && m.seat === 0 && !m.challenge && m.opponent === null && m.backing === null && m.backerSeat === null;

/** The oldest open Match older than `mine` that this Player may take a seat in, else null. */
async function olderCandidate(d: QueueDeps, mine: ChainMatch): Promise<string | null> {
  const now = Math.floor((d.now?.() ?? Date.now()) / 1000);
  const ids = (await d.listCandidates()).filter((id) => id !== mine.id).slice(0, READS_PER_ROUND);
  for (const id of ids) {
    const m = await d.readMatch(id);
    if (m && isOlder(m, mine) && joinable(d, m, now)) return id;
  }
  return null;
}

/** How long a refund may take to hand the entry back before the move gives up waiting (the keeper returns it in steps). */
const REFUND_WAIT_MS = 90_000;
const REFUND_POLL_MS = 2_000;

/** Waits until the Match is closed (the entry is back). False when it is not within `REFUND_WAIT_MS`. */
async function refundDone(d: MergeDeps, id: string): Promise<boolean> {
  const pause = d.pause ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; waited <= REFUND_WAIT_MS; waited += REFUND_POLL_MS) {
    const m = await d.readMatch(id).catch(() => null);
    if (m && m.status !== "open" && m.status !== "active") return true;
    await pause(REFUND_POLL_MS);
  }
  return false;
}

/**
 * Two Players who enter the Queue within a moment of each other can each open a Match, because neither list shows the
 * other's yet. While a Player waits alone, this looks for an OLDER open Match to take instead. Only the younger of two
 * waiting Matches ever moves, so the two can never move at once and the older one stays put.
 *
 * Order: refund first, then join (through `queueEntry`), never join then refund. `refund_match` closes the Match to joiners
 * at once (it is Refunding, the entry comes back in keeper steps), so from that instant the Player cannot be seated in
 * two Matches, whereas joining first would leave a window in which a third Player can take the abandoned seat. The join
 * does not wait for the entry to come back: it draws on the Player's other Gemas, and when those are too few it waits
 * for the refund to finish and tries again. A refund that fails because someone just joined leaves the Player where they are.
 */
export async function mergeQueue(d: MergeDeps, mine: ChainMatch): Promise<Merged> {
  if (!canMove(mine) || mine.game !== d.game || mine.entry !== d.entry) return { moved: false };
  if ((await olderCandidate(d, mine)) === null) return { moved: false };

  d.onStep?.("Found an older Match…");
  try {
    await d.refund(mine.id);
  } catch (e) {
    const r = await classifySend(d, e, mine.id, (m) => m.status !== "open");
    if (r === "unknown") throw e instanceof TxUnconfirmedError ? new QueueUnconfirmedError(mine.id, e) : e;
    const now = await d.readMatch(mine.id).catch(() => null);
    // Failed and still waiting (or paired meanwhile): stay. Only a refund that took effect moves on.
    if (r === "failed" && (now === null || now.status === "open" || now.opponent !== null)) return { moved: false };
  }
  // The Match being refunded still counts as unfinished until it closes: it is not the Match this Player is in.
  const next: QueueDeps = { ...d, unfinished: async () => (await d.unfinished()).filter((m) => m.id !== mine.id) };
  try {
    return { moved: true, entered: await queueEntry(next) };
  } catch (e) {
    if (e instanceof QueueUnconfirmedError) throw e;
    // Most likely too few free Gemas while the old entry is still on its way back.
    if (!(await refundDone(d, mine.id))) throw e;
    return { moved: true, entered: await queueEntry(next) };
  }
}
