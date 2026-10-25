import type { MoveArg } from "./live-chain";
import { MAX_PLAY_BATCH } from "./live-chain";
import { burstErrorName } from "./live-errors";

/** What the submitter needs from the chain and the clock. */
export interface BurstIo {
  /** Sends 1..8 moves. `expectedCount` is the on-chain move count before them; `hidden` picks `play_hidden`. */
  send(moves: MoveArg[], expectedCount: number, hidden: boolean): Promise<unknown>;
  /** The Board's move count on chain, or null when it cannot be read right now. */
  movesOnChain(): Promise<number | null>;
  /** The scores are hidden now (from the freeze): the play must be the hidden one. */
  frozen(): boolean;
}

/** The program refused the run itself: resending cannot help. */
const FINAL = new Set(["IllegalMove", "PlayWindowClosed", "RunOver", "NotBegan", "NotAPlayer", "StaleBinding", "WrongPhase", "BadBatch"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SubmitterOptions {
  /** Moves already on chain (a resumed run). */
  startCount?: number;
  /** Moves per transaction, at most 8. */
  batch?: number;
  /** A push is flushed this long after the last, unless the batch is full. */
  flushMs?: number;
  retries?: number;
  backoffMs?: number;
}

/**
 * Streams a Player's moves to their hidden Board: batches of up to 8, flushed every ~0.5 s and at time-up, in order, never
 * blocking the game. The on-chain move count is the nonce: a batch carries the count it expects, so a resend of a batch that
 * landed is refused as `WrongCount` and changes nothing; the submitter then reads the Board and sends only what did not land.
 * `play` after the freeze fails `Frozen` and goes again as `play_hidden`; `play_hidden` before it fails `NotFrozen` and goes
 * again as `play`.
 */
export class BurstSubmitter {
  private pending: MoveArg[] = [];
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Moves the chain has accepted. */
  landed: number;
  error: Error | null = null;
  private readonly batch: number;
  private readonly flushMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;

  constructor(
    private readonly io: BurstIo,
    opts: SubmitterOptions = {},
  ) {
    this.landed = opts.startCount ?? 0;
    this.batch = Math.min(opts.batch ?? MAX_PLAY_BATCH, MAX_PLAY_BATCH);
    this.flushMs = opts.flushMs ?? 500;
    this.retries = opts.retries ?? 4;
    this.backoffMs = opts.backoffMs ?? 400;
  }

  push(move: MoveArg) {
    this.pending.push(move);
    if (this.pending.length >= this.batch) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs);
  }

  /** Sends what is pending, in batches of at most `batch`. */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.pending.length) {
      const moves = this.pending.splice(0, this.batch);
      this.queue = this.queue.then(async () => {
        if (this.error) return;
        try {
          await this.send(moves);
        } catch (e) {
          this.error = e instanceof Error ? e : new Error(String(e));
        }
      });
    }
  }

  private async send(moves: MoveArg[]) {
    let left = moves;
    let hidden = this.io.frozen();
    for (let attempt = 0; ; attempt++) {
      try {
        await this.io.send(left, this.landed, hidden);
        this.landed += left.length;
        return;
      } catch (e) {
        const name = burstErrorName(e);
        if (name && FINAL.has(name)) throw e;
        if (attempt >= this.retries) throw e;
        if (name === "Frozen") {
          hidden = true;
          continue;
        }
        if (name === "NotFrozen") {
          hidden = false;
          continue;
        }
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
        const done = onChain - this.landed;
        if (done >= left.length) {
          this.landed += left.length;
          return;
        }
        if (done > 0) {
          this.landed = onChain;
          left = left.slice(done);
        } else if (done < 0) {
          throw e;
        }
        hidden = this.io.frozen();
      }
    }
  }

  /** Sends everything left (time is up). Returns how many moves the chain holds. */
  async finish(): Promise<number> {
    this.flush();
    await this.queue;
    return this.landed;
  }
}
