import type { MoveArg } from "./live-chain";
import { HIDDEN_BEATS, HIDDEN_BEAT_SLOTS, HIDDEN_FIRST_BEAT_SLOTS, MAX_PLAY_BATCH, PUBLIC_GUARD_SLOTS } from "./live-chain";
import { burstErrorName } from "./live-errors";

/** What the submitter needs from the chain and the clock. */
export interface BurstIo {
  /** Sends 1..8 moves (`hidden` false), or one hidden beat of 0..8 moves (`hidden` true; `beat` is its number). */
  send(moves: MoveArg[], expectedCount: number, hidden: boolean, beat: number): Promise<unknown>;
  /** The Board's move count on chain, or null when it cannot be read right now. */
  movesOnChain(): Promise<number | null>;
  /** The rollup's slot now (the page's slot clock, never the wall clock). */
  slot(): number;
  /** How many moves the pace lets the Board hold at `slot`; omitted = no client-side limit. */
  paceLimit?(slot: number): number;
}

/** The program refused the run itself: resending cannot help. */
const FINAL = new Set(["IllegalMove", "PlayWindowClosed", "RunOver", "NotBegan", "NotAPlayer", "StaleBinding", "WrongPhase", "BadBatch"]);

const CLOCK_POLL_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SubmitterOptions {
  /** Moves already on chain (a resumed run). */
  startCount?: number;
  /** Moves per public transaction, at most 8. */
  batch?: number;
  /** A push is flushed this long after the last, unless the batch is full. */
  flushMs?: number;
  retries?: number;
  backoffMs?: number;
  /** The table's freeze slot (`start_slot + 80 s`). Without it every play is public. */
  freezeSlot?: number;
  /** Milliseconds per rollup slot, for the beat timer. */
  msPerSlot?: number;
}

/**
 * Streams a Player's moves to their Board.
 *
 * Before the freeze: batches of up to 8 as public `play`, flushed ~0.5 s after the last move, in order, never blocking the game.
 * The Board's move count is the nonce: a resend of a batch that landed is refused as `WrongCount` and the submitter reads the
 * Board and sends only what did not land.
 *
 * From the freeze: the hidden beat. Exactly one `play_hidden` goes out per beat slot, on a grid fixed by the table, whether or
 * not there is a move, so a watcher of the public accounts learns nothing about when the Player moved. A beat never retries and
 * never goes early or late because of the queue; every beat carries the unconfirmed moves from the Board's count (the program
 * skips any it already holds), so a lost beat costs one beat of delay and nothing else. The beats continue after the Player's
 * run is over.
 */
export class BurstSubmitter {
  /** Moves not yet confirmed on chain, in order; the first is move number `landed`. */
  private unlanded: MoveArg[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private beatTimer: ReturnType<typeof setTimeout> | null = null;
  private pumping: Promise<void> | null = null;
  private stopped = false;
  private nextBeat = 0;
  private readonly inflight = new Set<Promise<void>>();
  private reconciling = false;
  /** The program said the scores are frozen: no more public plays, whatever the clock says. */
  private publicClosed = false;
  /** Moves the chain has accepted. */
  landed: number;
  error: Error | null = null;
  /** Hidden beats sent so far (a test and evidence hook). */
  beatsSent = 0;
  private readonly batch: number;
  private readonly flushMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly msPerSlot: number;

  constructor(
    private readonly io: BurstIo,
    private readonly opts: SubmitterOptions = {},
  ) {
    this.landed = opts.startCount ?? 0;
    this.batch = Math.min(opts.batch ?? MAX_PLAY_BATCH, MAX_PLAY_BATCH);
    this.flushMs = opts.flushMs ?? 500;
    this.retries = opts.retries ?? 4;
    this.backoffMs = opts.backoffMs ?? 400;
    this.msPerSlot = opts.msPerSlot ?? 10;
    if (opts.freezeSlot !== undefined) this.startBeats(opts.freezeSlot);
  }

  /** Public plays are allowed until a little before the freeze, so none reaches the program after it. */
  private isPublic(): boolean {
    const f = this.opts.freezeSlot;
    return !this.publicClosed && (f === undefined || this.io.slot() < f - PUBLIC_GUARD_SLOTS);
  }

  push(move: MoveArg) {
    this.unlanded.push(move);
    if (!this.isPublic()) return; // waits for the next beat
    if (this.unlanded.length >= this.batch) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  /** Sends what is pending as public plays, in batches of at most `batch`; a no-op once the hidden beats have taken over. */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pumping ??= this.pump().finally(() => {
      this.pumping = null;
    });
  }

  private async pump() {
    while (!this.error && !this.stopped && this.unlanded.length && this.isPublic()) {
      try {
        await this.sendPublic(this.unlanded.slice(0, this.batch));
      } catch (e) {
        this.error = e instanceof Error ? e : new Error(String(e));
      }
    }
  }

  /** Marks `count` moves as on chain (never backwards). */
  private advance(count: number) {
    if (count <= this.landed) return;
    this.unlanded.splice(0, count - this.landed);
    this.landed = count;
  }

  private async sendPublic(win: MoveArg[]) {
    for (let attempt = 0; ; attempt++) {
      // A retry after a pace refusal or an unknown outcome may not cross the guard before the freeze: the moves wait for a beat.
      if (attempt > 0 && !this.isPublic()) return;
      const expected = this.landed;
      try {
        await this.io.send(win, expected, false, 0);
        this.advance(expected + win.length);
        return;
      } catch (e) {
        const name = burstErrorName(e);
        if (name && FINAL.has(name)) throw e;
        // The freeze arrived under the send: the moves stay queued for the hidden beat.
        if (name === "Frozen") {
          this.publicClosed = true;
          return;
        }
        if (attempt >= this.retries) throw e;
        if (name === "TooFast") {
          await sleep(this.backoffMs);
          continue;
        }
        // WrongCount, or a send whose outcome is unknown: the Board says what landed.
        let onChain: number | null = null;
        for (let read = 0; read < 3 && onChain === null; read++) {
          if (name !== "WrongCount") await sleep(this.backoffMs * (attempt + 1));
          onChain = await this.io.movesOnChain().catch(() => null);
        }
        // Unreadable: a blind resend could apply moves twice.
        if (onChain === null) throw e;
        if (onChain < this.landed) throw e;
        this.advance(Math.min(onChain, this.landed + this.unlanded.length));
        if (!this.unlanded.length || !this.isPublic()) return;
        win = this.unlanded.slice(0, this.batch);
      }
    }
  }

  // -- the hidden beat --------------------------------------------------------------------------

  private startBeats(freeze: number) {
    const first = freeze + HIDDEN_FIRST_BEAT_SLOTS;
    // The page's slot clock may not be ready yet (it reads 0): wait for it, or every beat would be scheduled for the far future.
    if (this.io.slot() <= 0) {
      this.beatTimer = setTimeout(() => this.startBeats(freeze), CLOCK_POLL_MS);
      return;
    }
    // A reload or a late start joins the grid where it is.
    this.nextBeat = Math.max(0, Math.ceil((this.io.slot() - first) / HIDDEN_BEAT_SLOTS));
    this.scheduleBeat(first);
  }

  private scheduleBeat(first: number) {
    if (this.stopped || this.nextBeat >= HIDDEN_BEATS) return;
    const due = first + this.nextBeat * HIDDEN_BEAT_SLOTS;
    const wait = Math.max(0, (due - this.io.slot()) * this.msPerSlot);
    this.beatTimer = setTimeout(() => {
      if (this.stopped) return;
      this.fireBeat(this.nextBeat);
      this.nextBeat += 1;
      this.scheduleBeat(first);
    }, wait);
  }

  /** One beat, no matter what: nothing here depends on how many moves are waiting, and it never retries. */
  private fireBeat(k: number) {
    const expected = this.landed;
    const room = this.io.paceLimit ? Math.max(0, this.io.paceLimit(this.io.slot()) - expected) : MAX_PLAY_BATCH;
    const win = this.unlanded.slice(0, Math.min(MAX_PLAY_BATCH, room));
    this.beatsSent += 1;
    const run = this.io
      .send(win, expected, true, k)
      .then(() => this.advance(expected + win.length))
      .catch((e) => this.beatFailed(e, win.length))
      .finally(() => this.inflight.delete(run));
    this.inflight.add(run);
  }

  private beatFailed(e: unknown, carried: number) {
    const name = burstErrorName(e);
    if (name && FINAL.has(name)) {
      // An empty beat refused at the very end of the window changes nothing for the Player.
      if (carried > 0) this.error = e instanceof Error ? e : new Error(String(e));
      return;
    }
    if (name === "WrongCount") void this.reconcile();
    // Anything else: the moves ride on the next beat.
  }

  /** The Board is somewhere else than this page thought (another device played): adopt its count. */
  private async reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const onChain = await this.io.movesOnChain().catch(() => null);
      if (onChain !== null) this.advance(Math.min(onChain, this.landed + this.unlanded.length));
    } finally {
      this.reconciling = false;
    }
  }

  /** No more sends (the Match is over or the page closes). */
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.beatTimer) clearTimeout(this.beatTimer);
    this.timer = this.beatTimer = null;
  }

  /**
   * Time is up. Sends what is pending as public plays if the freeze has not come; in the hidden window it only waits for the
   * beats still to go (a send of its own would break the rhythm). Returns how many moves the chain holds.
   */
  async finish(): Promise<number> {
    this.flush();
    await this.pumping;
    while (!this.stopped && this.opts.freezeSlot !== undefined && this.nextBeat < HIDDEN_BEATS && !this.isPublic() && !this.error) await sleep(this.msPerSlot * HIDDEN_BEAT_SLOTS);
    await Promise.allSettled([...this.inflight]);
    return this.landed;
  }
}
