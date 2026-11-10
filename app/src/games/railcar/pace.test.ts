import { describe, expect, it } from "vitest";
import { MAX_GAP_FACTOR, MIN_GAP_MS, MIN_SIGNAL_MS, pageIntervalMs, poissonGapMs, signalIntervalMs } from "./flow";
import { BACKUP_QUIET_MS, PaceWatch, backupDue } from "./pace";

describe("PaceWatch: how long the ride's pace mark has stood still, by the page's own reads", () => {
  it("counts from the read that first showed the mark, and restarts whenever it moves", () => {
    const w = new PaceWatch();
    w.read(100n, 1_000);
    expect(w.quietMs(1_500)).toBe(500);
    w.read(100n, 3_000);
    expect(w.quietMs(3_000)).toBe(2_000);
    w.read(101n, 3_500);
    expect(w.quietMs(3_500)).toBe(0);
  });

  it("only counts time the page actually read the Table: no read lately means it cannot tell, so no backup", () => {
    const w = new PaceWatch();
    w.read(100n, 0);
    w.read(100n, 10_000);
    expect(w.quietMs(10_000)).toBe(10_000);
    expect(w.quietMs(10_000 + 5_000)).toBe(0);
  });

  it("a new ride (reset) starts over", () => {
    const w = new PaceWatch();
    w.read(100n, 0);
    w.read(100n, 9_000);
    w.reset();
    expect(w.quietMs(9_000)).toBe(0);
  });
});

describe("backupDue", () => {
  it("a Jumped Player's page waits for a clear gap, a few hundred ms later per seat so backups don't all go at once", () => {
    expect(backupDue({ quietMs: BACKUP_QUIET_MS - 1, tableSeat: 0 })).toBe(false);
    expect(backupDue({ quietMs: BACKUP_QUIET_MS, tableSeat: 0 })).toBe(true);
    expect(backupDue({ quietMs: BACKUP_QUIET_MS, tableSeat: 3 })).toBe(false);
    expect(backupDue({ quietMs: BACKUP_QUIET_MS + 3 * 250, tableSeat: 3 })).toBe(true);
    // the stagger is bounded
    expect(backupDue({ quietMs: BACKUP_QUIET_MS + 9 * 250, tableSeat: 99 })).toBe(true);
  });
});

/**
 * A car as the pages see it. Every page beats at its own interval from a random start; an aboard page always signals; a page
 * that is off signals only when `backupDue`. A signal reaches every page's read 600 ms later. Jumped seats are the first
 * `off` seats; the first `ghosts` aboard seats are closed tabs.
 */
function simulate(o: { seated: number; off: number; ghosts?: number; secs: number; seed?: number }) {
  const LATENCY = 600;
  let r = o.seed ?? 7;
  const rand = () => (r = (r * 1103515245 + 12345) % 2147483648) / 2147483648;
  const aboardN = o.seated - o.off;
  const ghosts = o.ghosts ?? 0;
  const pages = Array.from({ length: o.seated }, (_, seat) => {
    const off = seat < o.off;
    const interval = pageIntervalMs({ aboard: aboardN, seated: o.seated, mine: off ? "off" : "aboard" });
    return { seat, off, interval, next: off ? rand() * interval : poissonGapMs(interval, rand()), watch: new PaceWatch(), live: off || seat - o.off >= ghosts };
  });
  const landed: number[] = [];
  const sent: number[] = [];
  const backups: number[] = [];
  let paceSlot = 1n;
  for (let t = 0; t < o.secs * 1000; t += 50) {
    while (landed.length && landed[0] <= t) {
      landed.shift();
      paceSlot += 1n;
    }
    for (const p of pages) {
      if (!p.live) continue;
      // each page reads the Table about every 800 ms
      if (t % 800 === 0) p.watch.read(paceSlot, t);
      if (t < p.next) continue;
      p.next = t + (p.off ? p.interval : poissonGapMs(p.interval, rand()));
      if (p.off && !backupDue({ quietMs: p.watch.quietMs(t), tableSeat: p.seat })) continue;
      sent.push(t);
      if (p.off) backups.push(t);
      landed.push(t + LATENCY);
    }
  }
  const from = 20_000;
  const after = (xs: number[]) => xs.filter((t) => t >= from).length;
  return { rate: after(sent) / (o.secs - from / 1000), backups: after(backups) };
}

describe("signals per second for one car", () => {
  for (const seated of [5, 20, 100]) {
    for (const share of [0, 0.5, 0.95]) {
      const off = Math.floor(seated * share);
      if (seated - off < 1) continue;
      it(`${seated} seated, ${off} off: about 5 a second (2 a second per page when 1 is aboard: the 0.5 s floor), never the 7 to 10 the old backups made`, () => {
        const { rate } = simulate({ seated, off, secs: 200 });
        const aboard = seated - off;
        expect(rate).toBeGreaterThan(Math.min(5, aboard * 2) * 0.7);
        expect(rate).toBeLessThan(6.5);
      });
    }
  }

  it("a single aboard Player still signals at the 0.5 s floor", () => {
    expect(signalIntervalMs(1)).toBe(MIN_SIGNAL_MS);
  });

  it("every aboard page closed: the backups take over at a slower rate (about one every 2.5 s or less) and the ride still moves", () => {
    const { rate } = simulate({ seated: 20, off: 10, ghosts: 10, secs: 200 });
    expect(rate).toBeGreaterThan(0.25);
    expect(rate).toBeLessThan(1.5);
  });
});

describe("quiet gaps that are not a missing sender", () => {
  for (const aboard of [1, 2, 5, 20, 100]) {
    it(`${aboard} aboard live, 5 Jumped: backups send under once per 180 s ride (a false quiet)`, () => {
      for (const seed of [1, 2, 3]) expect(simulate({ seated: aboard + 5, off: 5, secs: 200, seed }).backups).toBeLessThanOrEqual(1);
    });
  }
});

describe("poissonGapMs", () => {
  it("is exponential-ish inside its clamp: mean within 5 % and coefficient of variation near 1", () => {
    let r = 11;
    const u = () => (r = (r * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (const mean of [1_000, 5_000, 20_000]) {
      const xs = Array.from({ length: 20_000 }, () => poissonGapMs(mean, u()));
      const m = xs.reduce((a, b) => a + b) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
      expect(Math.abs(m / mean - 1)).toBeLessThan(0.05);
      expect(sd / m).toBeGreaterThan(0.85);
      expect(sd / m).toBeLessThan(1.1);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(MIN_GAP_MS);
      expect(Math.max(...xs)).toBeLessThanOrEqual(MAX_GAP_FACTOR * mean);
    }
  });
});
