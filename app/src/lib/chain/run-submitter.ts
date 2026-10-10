import type { Move } from "@/games/block-puzzle/chain";

/** What the submitter needs from the chain: send moves, close the run, and read how many moves the Board holds. */
export interface RunIo {
  play(moves: Move[]): Promise<unknown>;
  finish(): Promise<unknown>;
  /** The Board's move count on chain, or null when it cannot be read right now. */
  movesOnChain(): Promise<number | null>;
}

/** The program refused the moves: resending cannot help, and later batches would build on a wrong state. */
const REFUSED = /Error Message:|IllegalMove|DeadlinePassed|PlayWindowClosed|RunClosed|NotBegan|BadBatch|custom program error/i;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Streams a Player's moves to their private Board: batched, in order, never blocking the game.
 * Batches are small (a few placements) so the on-chain score trails the screen by about a second.
 *
 * A failed send is retried, but moves carry no index on chain, so a resend first reads the Board's
 * move count and sends only the moves that did not land. A program refusal is final.
 */
export class RunSubmitter {
  private pending: Move[] = [];
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  error: Error | null = null;
  submitted = 0;

  constructor(
    private readonly io: RunIo,
    private readonly batch = 4,
    private readonly idleMs = 1200,
    private readonly retries = 4,
    private readonly backoffMs = 800,
  ) {}

  push(move: Move) {
    this.pending.push(move);
    if (this.timer) clearTimeout(this.timer);
    if (this.pending.length >= this.batch) this.flush();
    else this.timer = setTimeout(() => this.flush(), this.idleMs);
  }

  private flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const moves = this.pending.splice(0);
    if (!moves.length) return;
    this.queue = this.queue.then(async () => {
      if (this.error) return;
      try {
        await this.send(moves);
      } catch (e) {
        this.error = e instanceof Error ? e : new Error(String(e));
      }
    });
  }

  private async send(moves: Move[]) {
    const before = this.submitted;
    let left = moves;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.io.play(left);
        this.submitted = before + moves.length;
        return;
      } catch (e) {
        if (attempt >= this.retries || REFUSED.test(e instanceof Error ? e.message : String(e))) throw e;
        let onChain: number | null = null;
        for (let read = 0; read < 3 && onChain === null; read++) {
          await sleep(this.backoffMs * (attempt + 1));
          onChain = await this.io.movesOnChain().catch(() => null);
        }
        // Unreadable: we cannot tell what landed, and a blind resend could apply moves twice.
        if (onChain === null) throw e;
        const landed = Math.max(0, onChain - before);
        if (landed >= moves.length) {
          this.submitted = before + moves.length;
          return;
        }
        left = moves.slice(landed);
      }
    }
  }

  /** Sends everything left, then closes the run on chain. Returns how many moves landed. */
  async finish(): Promise<number> {
    this.flush();
    await this.queue;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        await this.io.finish();
        break;
      } catch (e) {
        if (REFUSED.test(e instanceof Error ? e.message : String(e))) break;
        await sleep(this.backoffMs * (attempt + 1));
      }
    }
    return this.submitted;
  }
}
