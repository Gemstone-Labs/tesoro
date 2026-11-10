/**
 * A Railcar page's ride signals: one `tick` (or `signal`) per beat, on a fixed cadence that never waits for a confirmation.
 *
 * - The interval runs from beat to beat, not from a confirm to the next send, so a rollup that takes 1.5 s to confirm still
 *   gets one beat per interval (devnet 2026-11-08: waiting for each confirm stretched a 1 s interval to ~2.5 s).
 * - The blockhash is fetched in the background after each send, so a beat sends at once. The rollup makes a new hash about
 *   every 10 ms slot and keeps one valid for about a minute.
 * - Never the same bytes twice: a transaction resent with the same message is the same signature, and the rollup does nothing
 *   with it (the 2026-10-22 Vanguard bug). A beat whose message was already sent under the current hash is skipped.
 * - At most `maxInFlight` beats wait for a status; a beat beyond that is skipped (a stalled rollup does not pile up sends).
 * - The first beat refused because the ride is over (`WrongPhase`, or `StaleBinding` for a later car) stops the ticker.
 * - A pressed Brake rides every beat until one lands (`next()` says what a beat carries; a repeat after it landed does nothing
 *   on chain), so it is never a transaction of its own.
 */
import { Transaction, type TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";

/** What the ticker needs from the rollup. */
export interface TickerIo {
  /** The rollup's latest blockhash. */
  blockhash(): Promise<string>;
  /** Signs and sends (no preflight); the signature. */
  send(signer: ChainSigner, tx: Transaction): Promise<string>;
  /** Statuses of sent signatures, in order: null while unseen, else whether it failed. */
  statuses(sigs: string[]): Promise<({ err: unknown } | null)[]>;
}

/** One beat's transaction: a tick by the seat key (carrying the Brake or not) or a page key's signal. */
export interface Beat {
  signer: ChainSigner;
  ixs: TransactionInstruction[];
  /** This beat carries the Player's Brake. */
  brake: boolean;
}

export interface TickerOptions {
  /** What to send on this beat; null sends nothing. Read at every beat. */
  next(): Beat | null;
  /** The interval to the next beat, read at every beat. */
  intervalMs(): number;
  /** Wait before the first beat (default: a random part of the interval, so the pages' beats spread out). */
  startDelayMs?: number;
  /** Beats sent and not yet seen beyond this are skipped (default 3). */
  maxInFlight?: number;
  /** A beat unseen this long no longer counts as in flight. */
  confirmTimeoutMs?: number;
  /** How often statuses are asked for (default: 1.5 times the beat interval, between 0.4 s and 1.2 s, so a page asks about once per beat). */
  pollMs?: number;
  /** A beat landed without error. */
  onLanded?(beat: Beat): void;
  /** A beat was refused because the ride is over; the ticker has stopped. */
  onEnded?(): void;
}

/** `WrongPhase` (the ride is over) and `StaleBinding` (the Table is on another car). */
const OVER_CODES = new Set([6009, 6016]);
/** A hash older than this is not used (the rollup keeps one valid for about a minute). */
const HASH_MAX_AGE_MS = 30_000;
const MIN_POLL_MS = 400;
const MAX_POLL_MS = 1_200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function customCode(err: unknown): number | null {
  const ie = (err as { InstructionError?: [number, unknown] } | null)?.InstructionError;
  const c = (ie?.[1] as { Custom?: unknown } | undefined)?.Custom;
  return typeof c === "number" ? c : null;
}

export class RideTicker {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private due: number;
  /** The newest hash seen, when it was first seen, and every message sent under it. */
  private hash: { value: string; at: number; sent: Set<string> } | null = null;
  private fetching: Promise<void> | null = null;
  /** Beats being sent or waiting for a status. */
  private flying = 0;
  private readonly waiting = new Map<string, { beat: Beat; at: number }>();
  private polling = false;
  private readonly confirmTimeoutMs: number;

  constructor(
    private readonly io: TickerIo,
    private readonly opts: TickerOptions,
  ) {
    this.confirmTimeoutMs = opts.confirmTimeoutMs ?? 6_000;
    void this.refresh();
    this.due = Date.now() + (opts.startDelayMs ?? Math.random() * opts.intervalMs());
    this.schedule();
  }

  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => this.fire(), Math.max(0, this.due - Date.now()));
  }

  private fire() {
    if (this.stopped) return;
    void this.beat();
    const now = Date.now();
    this.due += this.opts.intervalMs();
    // a throttled tab: carry on from now, no burst to catch up
    if (this.due <= now) this.due = now + this.opts.intervalMs();
    this.schedule();
  }

  private usableHash() {
    return this.hash && Date.now() - this.hash.at < HASH_MAX_AGE_MS ? this.hash : null;
  }

  /** Fetches the latest hash (one fetch at a time). A hash handed out again keeps what was sent under it. */
  private refresh(): Promise<void> {
    this.fetching ??= this.io
      .blockhash()
      .then((value) => {
        if (this.hash?.value !== value) this.hash = { value, at: Date.now(), sent: new Set() };
      })
      .catch(() => undefined)
      .finally(() => {
        this.fetching = null;
      });
    return this.fetching;
  }

  private pollEvery(): number {
    return this.opts.pollMs ?? Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, 1.5 * this.opts.intervalMs()));
  }

  private async beat() {
    if (this.flying >= (this.opts.maxInFlight ?? 3)) return;
    const b = this.opts.next();
    if (!b) return;
    this.flying += 1;
    let counted = true;
    const release = () => {
      if (counted) this.flying -= 1;
      counted = false;
    };
    try {
      let h = this.usableHash();
      if (!h) {
        // only before the first hash came (or after a minute without one)
        await this.refresh();
        h = this.usableHash();
        if (!h || this.stopped) return release();
      }
      const tx = new Transaction().add(...b.ixs);
      tx.feePayer = b.signer.publicKey;
      tx.recentBlockhash = h.value;
      const message = tx.serializeMessage().toString("base64");
      if (h.sent.has(message)) {
        void this.refresh();
        return release();
      }
      h.sent.add(message);
      void this.refresh();
      const sig = await this.io.send(b.signer, tx);
      if (this.stopped) return release();
      this.waiting.set(sig, { beat: b, at: Date.now() });
      counted = false; // the status poll releases it
      void this.poll();
    } catch {
      // a send that failed to go out: the next beat is another try
      release();
    }
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      while (this.waiting.size && !this.stopped) {
        await sleep(this.pollEvery());
        const sigs = [...this.waiting.keys()];
        const sts = await this.io.statuses(sigs).catch(() => null);
        if (this.stopped) return;
        const now = Date.now();
        sigs.forEach((sig, i) => {
          const w = this.waiting.get(sig);
          if (!w) return;
          const st = sts?.[i];
          if (!st && now - w.at < this.confirmTimeoutMs) return;
          this.waiting.delete(sig);
          this.flying -= 1;
          if (!st) return;
          if (!st.err) this.opts.onLanded?.(w.beat);
          else if (OVER_CODES.has(customCode(st.err) ?? -1)) this.end();
        });
      }
    } finally {
      this.polling = false;
    }
  }

  private end() {
    if (this.stopped) return;
    this.stop();
    this.opts.onEnded?.();
  }

  /** No more beats (the ride is over or the page closes). */
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
