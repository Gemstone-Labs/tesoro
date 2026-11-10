import { Keypair, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keypairSigner } from "@/games/block-puzzle/chain";
import { RideTicker, type TickerIo, type TickerOptions } from "./ticker";

const PROGRAM = new PublicKey("ExpLHqvPEqbdEze5HaYWmnTsH9SXYa8jkXeuEvjRGzam");
const seatKey = keypairSigner(Keypair.generate());
/** A tick's bytes as far as the test cares: the Brake flag in its data. */
const tickIx = (brake: boolean) => new TransactionInstruction({ programId: PROGRAM, keys: [], data: Buffer.from([7, brake ? 1 : 0]) });
/** A blockhash-shaped string (base58, 32 bytes), one per n. */
const hashAt = (n: number) => new PublicKey(Buffer.alloc(32, n + 1)).toBase58();
const wallErr = { InstructionError: [0, { Custom: 6009 }] };

interface Sent {
  at: number;
  sig: string;
  hash: string;
  message: string;
  brake: boolean;
}

/**
 * A fake rollup. Every `getLatestBlockhash` takes `hashMs` and hands out a new hash (or `sameHash` every time); a send takes
 * `sendMs`; a transaction shows a status `confirmMs` after it was sent, with the error `errOf` gives it.
 */
function rollup(o: { hashMs?: number; sendMs?: number; confirmMs?: number; sameHash?: boolean; errOf?: (s: Sent, n: number) => unknown } = {}) {
  const sent: Sent[] = [];
  const same = hashAt(0);
  let hashes = 0;
  const io: TickerIo = {
    blockhash: async () => {
      await new Promise((r) => setTimeout(r, o.hashMs ?? 40));
      return o.sameHash ? same : hashAt(++hashes);
    },
    send: async (_signer, tx: Transaction) => {
      await new Promise((r) => setTimeout(r, o.sendMs ?? 40));
      const message = tx.serializeMessage().toString("base64");
      const s: Sent = { at: Date.now(), sig: `sig-${sent.length}`, hash: tx.recentBlockhash!, message, brake: tx.instructions[0].data[1] === 1 };
      sent.push(s);
      return s.sig;
    },
    statuses: async (sigs) => {
      await new Promise((r) => setTimeout(r, 40));
      return sigs.map((sig) => {
        const i = sent.findIndex((s) => s.sig === sig);
        const s = sent[i];
        if (!s || Date.now() - s.at < (o.confirmMs ?? 300)) return null;
        return { err: o.errOf?.(s, i) ?? null };
      });
    },
  };
  return { io, sent };
}

/** A tick every beat; a pressed Brake rides every beat until one lands. */
function page(over: Partial<TickerOptions> = {}) {
  const state = { brake: false, landedBrakes: 0, ended: 0 };
  const opts: TickerOptions = {
    intervalMs: () => 1_000,
    startDelayMs: 0,
    next: () => ({ signer: seatKey, ixs: [tickIx(state.brake)], brake: state.brake }),
    onLanded: (beat) => {
      // a second carrier landing after the first changes nothing on chain
      if (beat.brake && state.brake) {
        state.brake = false;
        state.landedBrakes += 1;
      }
    },
    onEnded: () => {
      state.ended += 1;
    },
    ...over,
  };
  return { opts, state };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("RideTicker", () => {
  it("keeps one beat per interval when confirmations take longer than the interval (devnet: ~1.5 s, the page sent every ~2.5 s)", async () => {
    const { io, sent } = rollup({ confirmMs: 1_500 });
    const t = new RideTicker(io, page().opts);
    await vi.advanceTimersByTimeAsync(10_050);
    t.stop();
    // beats at 0, 1 000, ..., 10 000 ms: 11 sends, each about one interval after the last
    expect(sent.length).toBe(11);
    const gaps = sent.slice(1).map((s, i) => s.at - sent[i].at);
    for (const g of gaps) expect(Math.abs(g - 1_000)).toBeLessThanOrEqual(50);
  });

  it("never sends the same bytes twice: under a hash the rollup keeps handing out, a plain tick goes once and a Brake once", async () => {
    const { io, sent } = rollup({ sameHash: true });
    const p = page();
    const t = new RideTicker(io, p.opts);
    await vi.advanceTimersByTimeAsync(3_050);
    p.state.brake = true;
    await vi.advanceTimersByTimeAsync(3_000);
    t.stop();
    expect(sent.map((s) => s.brake)).toEqual([false, true]);
    expect(new Set(sent.map((s) => s.message)).size).toBe(sent.length);
  });

  it("sends with a hash fetched in the background: each beat has a newer hash and none waits for a fetch", async () => {
    const { io, sent } = rollup({ hashMs: 300, confirmMs: 200 });
    const t0 = Date.now();
    const t = new RideTicker(io, page().opts);
    await vi.advanceTimersByTimeAsync(5_400);
    t.stop();
    expect(sent.length).toBe(6);
    expect(new Set(sent.map((s) => s.hash)).size).toBe(6);
    // after the first (which waits for the page's first hash), a beat sends 40 ms after it is due
    for (const [i, s] of sent.slice(1).entries()) expect(s.at - t0 - (i + 1) * 1_000).toBe(40);
  });

  it("keeps at most 3 beats in flight while the rollup shows nothing, and starts again once they time out", async () => {
    const { io, sent } = rollup({ confirmMs: 60_000 });
    const t = new RideTicker(io, page({ confirmTimeoutMs: 6_000 }).opts);
    await vi.advanceTimersByTimeAsync(5_500);
    expect(sent.length).toBe(3);
    await vi.advanceTimersByTimeAsync(3_000);
    t.stop();
    expect(sent.length).toBeGreaterThan(3);
  });

  it("stops at the first beat refused because the ride is over (6009): no more sends, onEnded once", async () => {
    const { io, sent } = rollup({ confirmMs: 300, errOf: (_s, n) => (n >= 3 ? wallErr : null) });
    const p = page();
    new RideTicker(io, p.opts);
    await vi.advanceTimersByTimeAsync(20_000);
    // beats 0-2 land, beat 3 (3 000 ms) is refused; statuses are asked for every ~1.2 s, so beat 4 (4 000 ms) goes out before the
    // refusal is seen (a harmless refused send), and nothing after it
    expect(sent.length).toBe(5);
    expect(p.state.ended).toBe(1);
  });

  it("does not stop on another error (a beat that failed for any other reason is just lost)", async () => {
    const { io, sent } = rollup({ errOf: (_s, n) => (n === 1 ? { InstructionError: [0, { Custom: 6014 }] } : null) });
    const p = page();
    const t = new RideTicker(io, p.opts);
    await vi.advanceTimersByTimeAsync(4_050);
    t.stop();
    expect(sent.length).toBe(5);
    expect(p.state.ended).toBe(0);
  });

  it("carries a pressed Brake on the next beat and on every beat until one lands, then on none", async () => {
    const { io, sent } = rollup({ confirmMs: 1_500, errOf: (s, n) => (n === 3 ? { InstructionError: [0, "AccountInUse"] } : null) });
    const p = page();
    const t = new RideTicker(io, p.opts);
    await vi.advanceTimersByTimeAsync(2_500);
    p.state.brake = true;
    await vi.advanceTimersByTimeAsync(5_550);
    t.stop();
    // pressed at 2.5 s: beat 3 (3 s) carries it and fails, beats 4, 5 and 6 carry it (the landing of beat 4 is seen at the next
    // status poll, ~1.2 s later); beats 7 and 8 carry nothing
    expect(sent.map((s) => s.brake)).toEqual([false, false, false, true, true, true, true, false, false]);
    expect(p.state.landedBrakes).toBe(1);
  });

  it("reads the interval at every beat: a car with fewer aboard beats faster without a restart", async () => {
    const { io, sent } = rollup();
    let interval = 1_000;
    const t = new RideTicker(io, page({ intervalMs: () => interval }).opts);
    await vi.advanceTimersByTimeAsync(2_050);
    interval = 500;
    await vi.advanceTimersByTimeAsync(2_000);
    t.stop();
    // beats at 0, 1 000, 2 000 (which set the next for 3 000), then every 500: 3 000, 3 500, 4 000
    expect(sent.length).toBe(6);
  });

  it("sends nothing on a beat the page has nothing to send for, and keeps the cadence", async () => {
    const { io, sent } = rollup();
    let n = 0;
    const t = new RideTicker(io, page({ next: () => (n++ % 2 ? null : { signer: seatKey, ixs: [tickIx(false)], brake: false }) }).opts);
    await vi.advanceTimersByTimeAsync(4_050);
    t.stop();
    expect(sent.length).toBe(3);
  });

  describe("rollup requests per second (a banned IP is the cost of too many)", () => {
    async function perSecond(intervalMs: number, pollMs?: number) {
      const { io } = rollup({ confirmMs: 450 });
      const n = { blockhash: 0, send: 0, statuses: 0 };
      const counted: TickerIo = {
        blockhash: () => (n.blockhash++, io.blockhash()),
        send: (a, b) => (n.send++, io.send(a, b)),
        statuses: (x) => (n.statuses++, io.statuses(x)),
      };
      const t = new RideTicker(counted, page({ intervalMs: () => intervalMs, pollMs }).opts);
      await vi.advanceTimersByTimeAsync(30_000);
      t.stop();
      return { ...n, perSec: (n.blockhash + n.send + n.statuses) / 30 };
    }

    it("a page of a 5-aboard car (one beat a second) asks the rollup about 3 times a second, was 4 with the 400 ms status poll", async () => {
      const now = await perSecond(1_000);
      const before = await perSecond(1_000, 400);
      expect(now.send).toBeLessThanOrEqual(31);
      expect(now.statuses).toBeLessThanOrEqual(31);
      expect(now.perSec).toBeLessThanOrEqual(3.1);
      expect(before.perSec).toBeGreaterThan(now.perSec);
    });
  });
});
