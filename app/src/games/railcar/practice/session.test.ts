import { describe, expect, it } from "vitest";
import { impactMs, positionMs, refund, ride } from "../engine";
import { newPractice, practiceBrake, practiceJump, practiceView, simRiders, type PracticeRider } from "./session";

/** All zeros: the engine's longest ride (the Bomb at 120 s, the cap). */
const LONG = new Uint8Array(32);
const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (n * 131 + i * 17 + ((n >> 3) ^ i)) & 0xff);

const rider = (name: string, planMs: number, waits: Partial<PracticeRider> = {}): PracticeRider => ({ id: `practice:${name}`, name, planMs, screwsWaitMs: null, boltReactMs: null, sparkReactMs: null, ...waits });
const NEVER = 1_000_000;

type Result = Extract<ReturnType<typeof practiceView>, { phase: "result" }>;
const result = (v: ReturnType<typeof practiceView>): Result => {
  if (v.phase !== "result") throw new Error(`expected the Result, got ${v.phase}`);
  return v;
};
const gets = (v: Result) => Object.fromEntries(v.rows.map((r) => [r.me ? "You" : r.name, Number(r.gets)]));

describe("a Practice ride pays what a 100 entry would have", () => {
  it("the spec's worked example, as Dee: 203 / 142 / 125 / 0 / 0, fees 30", () => {
    // Ana Jumps at 8 s, Cy, Ben, then Dee (you) at 27-29 s; Eve stays aboard.
    let p = newPractice(LONG, [rider("Ana", 8_000), rider("Ben", 28_000), rider("Cy", 27_000), rider("Eve", NEVER)]);
    p = practiceJump(p, 29_000);
    const v = result(practiceView(p, 120_000));
    expect(gets(v)).toEqual({ You: 203, Ben: 142, Cy: 125, Ana: 0, Eve: 0 });
    expect(Number(v.fees)).toBe(30);
    expect(v.mine).toMatchObject({ headline: "Last off", gets: 203n, won: 103n });
    expect(v.wallMs).toBe(120_000);
  });

  it("ten aboard: one early Jump at 8 s, three placed, six aboard at Impact", () => {
    // Pot 1,000; nothing back to Ana; fees 6% = 60; 700 forfeited - 60 = 640 split 384 / 160 / 96.
    let p = newPractice(LONG, [rider("Ana", 8_000), rider("Ben", 28_000), rider("Cy", 27_000), ...["Eve", "Fin", "Gus", "Hal", "Ivy", "Jo"].map((n) => rider(n, NEVER))]);
    p = practiceJump(p, 29_000);
    const v = result(practiceView(p, 120_000));
    expect(gets(v)).toMatchObject({ You: 484, Ben: 260, Cy: 196, Ana: 0, Eve: 0, Jo: 0 });
    expect(Number(v.fees)).toBe(60);
    expect(Number(v.pot)).toBe(1_000);
    expect(v.rows.reduce((a, r) => a + Number(r.gets), 0) + Number(v.fees)).toBe(1_000);
  });

  it("you aboard at Impact get nothing; a Jump after Impact counts as aboard", () => {
    let p = newPractice(LONG, [rider("Ana", 8_000), rider("Ben", 28_000), rider("Cy", 27_000), rider("Dee", 29_000)]);
    p = practiceJump(p, 120_000);
    const v = result(practiceView(p, 121_000));
    expect(v.mine).toMatchObject({ headline: "Aboard at the blast", gets: 0n });
    expect(gets(v)).toMatchObject({ Dee: 203, Ben: 142, Cy: 125, Ana: 0, You: 0 });
  });

  it("nobody Jumps: every entry back, no fees", () => {
    const v = result(practiceView(newPractice(LONG, [rider("Ana", NEVER), rider("Ben", NEVER)]), 120_000));
    expect(v.outcome).toBe("refund");
    expect(v.mine).toMatchObject({ headline: "Nobody jumped", gets: 100n });
    expect(Number(v.fees)).toBe(0);
  });
});

describe("a Practice ride is the engine's ride", () => {
  it("the crash point, the Tells and Impact come from the engine for the seed, and the same seed replays the same ride", () => {
    for (const n of [1, 2, 3, 40, 77]) {
      const s = seed(n);
      const r = ride(s);
      const a = newPractice(s);
      expect(newPractice(s)).toEqual(a);
      expect(a.ride).toEqual(r);
      const at = (ms: number) => practiceView(a, ms);
      // Each Tell the ride shows appears at its engine position (no Brake: real ms = track ms); the others never do.
      const tellsAt = (ms: number) => {
        const v = at(ms);
        return v.phase === "ride" ? v.tells : null;
      };
      if (r.screwAtMs > 0) {
        expect(tellsAt(r.screwAtMs - 1)?.screws).toBe(r.falseScrews.length);
        expect(tellsAt(r.screwAtMs)?.screws).toBe(r.falseScrews.length + 1);
      }
      for (const [key, ms] of [["panel", r.boltAtMs], ["sparks", r.sparkAtMs]] as const) {
        if (ms === null) expect(tellsAt(r.crashMs - 1)?.[key]).toBe(false);
        else if (ms > 0) expect([tellsAt(ms - 1)?.[key], tellsAt(ms)?.[key]]).toEqual([false, true]);
      }
      expect(at(r.crashMs - 1).phase).toBe("ride");
      expect(result(at(r.crashMs)).wallMs).toBe(r.crashMs);
    }
  });

  it("my Brake halves the car for 5 s: Impact moves by the engine's rule, and an early Jump still brings nothing back", () => {
    const s = seed(9);
    const r = ride(s);
    let p = newPractice(s, [rider("Ana", NEVER)]);
    p = practiceBrake(p, 4_000);
    expect(practiceBrake(p, 6_000)).toEqual(p);
    expect(result(practiceView(p, impactMs([4_000], r.crashMs))).wallMs).toBe(impactMs([4_000], r.crashMs));
    expect(practiceView(p, impactMs([4_000], r.crashMs) - 1).phase).toBe("ride");
    p = practiceJump(p, 8_000);
    const v = practiceView(p, 8_500);
    expect(v.phase === "ride" && v.me).toMatchObject({ aboard: false, jumpMs: 8_000, back: refund(100n, positionMs([4_000], 8_000)) });
    expect(v.phase === "ride" && v.me).toMatchObject({ back: 0n });
  });

  it("a Brake or a Jump after Impact does nothing, and a second Jump does nothing", () => {
    const s = seed(5);
    const r = ride(s);
    const p = newPractice(s, [rider("Ana", NEVER)]);
    expect(practiceBrake(p, r.crashMs)).toEqual(p);
    expect(practiceJump(p, r.crashMs)).toEqual(p);
    const j = practiceJump(p, 1_000);
    expect(practiceJump(j, 2_000)).toEqual(j);
  });
});

/** The first seed from `from` whose ride is at least 30 s and shows the panel and the sparks or not, as asked. */
const seedShowing = (panel: boolean, sparks: boolean, also: (r: ReturnType<typeof ride>) => boolean = () => true): Uint8Array => {
  for (let n = 1; n < 5_000; n++) {
    const r = ride(seed(n));
    if (r.crashMs >= 30_000 && (r.boltAtMs !== null) === panel && (r.sparkAtMs !== null) === sparks && also(r)) return seed(n);
  }
  throw new Error("no such ride");
};

describe("a later Tell is not promised (decisions Q39)", () => {
  it("a ride with the panel and no sparks: the rider who gives the panel 4.5 s is paid, the one who holds for the sparks is aboard at Impact", () => {
    const s = seedShowing(true, false);
    const r = ride(s);
    const p = newPractice(s, [rider("Ben", NEVER, { boltReactMs: 4_500 }), rider("Cy", NEVER, { sparkReactMs: 1_000 })]);
    const v = result(practiceView(p, r.crashMs));
    const row = (name: string) => v.rows.find((x) => x.name === name)!;
    // The panel is at least 5 s ahead, so 4.5 s after it is always before the Bomb.
    expect(row("Ben").kind).toBe("place");
    expect(row("Ben").jumpMs).toBe(r.boltAtMs! + 4_500);
    expect(row("Cy").kind).toBe("aboard");
    // The panel shows and the sparks never do, to the last ms before the wall.
    const last = practiceView(p, r.crashMs - 1);
    expect(last.phase === "ride" && last.tells).toMatchObject({ panel: true, sparks: false });
  });

  it("a ride that shows the screws and nothing else: a rider who gives the screws 8 s is off, and no later Tell ever shows", () => {
    const s = seedShowing(false, false);
    const r = ride(s);
    const p = newPractice(s, [rider("Ana", NEVER, { screwsWaitMs: 8_000 }), rider("Ben", NEVER, { boltReactMs: 1_000, sparkReactMs: 1_000 })]);
    const v = result(practiceView(p, r.crashMs));
    const row = (name: string) => v.rows.find((x) => x.name === name)!;
    // Ana left 8 s after a screw: a false one if one stood alone that long, else the real ones (at least 9 s ahead).
    expect(row("Ana").kind).toBe("place");
    expect(row("Ana").jumpMs).toBeLessThanOrEqual(r.screwAtMs + 8_000);
    expect(row("Ben").kind).toBe("aboard");
    const last = practiceView(p, r.crashMs - 1);
    expect(last.phase === "ride" && last.tells).toEqual({ screws: r.falseScrews.length + 1, panel: false, sparks: false });
  });

  it("a wait on the panel ends when the sparks show, and a wait on a screw ends at the next Tell", () => {
    // A ride whose last false screw is under 20 s before the real ones, so no screw stands alone for 25 s.
    const s = seedShowing(true, true, (x) => x.screwAtMs - (x.falseScrews.at(-1) ?? x.screwAtMs) < 20_000);
    const r = ride(s);
    // Ben would leave 30 s after the panel and Ana 25 s after a screw: the next Tell comes first, and nothing else moves them.
    const p = newPractice(s, [rider("Ana", NEVER, { screwsWaitMs: 25_000 }), rider("Ben", NEVER, { boltReactMs: 30_000 }), rider("Cy", NEVER, { boltReactMs: 30_000, sparkReactMs: 1_200 })]);
    const v = result(practiceView(p, r.crashMs));
    const row = (name: string) => v.rows.find((x) => x.name === name)!;
    expect([row("Ana").kind, row("Ben").kind]).toEqual(["aboard", "aboard"]);
    expect(row("Cy").jumpMs).toBe(r.sparkAtMs! + 1_200);
  });

  it("every screw counts alike: the count rises by one at each false screw and at the real screws", () => {
    for (const n of [3, 8, 21, 55]) {
      const r = ride(seed(n));
      const p = newPractice(seed(n), []);
      const screws = [...r.falseScrews, r.screwAtMs];
      screws.forEach((at, i) => {
        if (at === 0 || at >= r.crashMs) return;
        const v = practiceView(p, at);
        expect(v.phase === "ride" && v.tells.screws).toBe(i + 1);
      });
    }
  });
});

describe("the simulated riders", () => {
  const RIDES = 400;
  const rides = Array.from({ length: RIDES }, (_, n) => {
    const p = newPractice(seed(n + 1000));
    return { p, v: result(practiceView(p, 700_000)) };
  });
  const riderRows = rides.flatMap(({ v }) => v.rows.filter((r) => !r.me));

  it("nine riders a car, each with a name, and the same seed gives the same riders", () => {
    for (const { p } of rides.slice(0, 20)) {
      expect(p.riders).toHaveLength(9);
      expect(new Set(p.riders.map((r) => r.name)).size).toBe(9);
    }
    expect(simRiders(seed(3))).toEqual(simRiders(seed(3)));
    expect(simRiders(seed(3))).not.toEqual(simRiders(seed(4)));
  });

  it("Jump at believable times: some early, most near the wall, some greedy enough to stay aboard", () => {
    // On rides of 30 s or more, a few riders are off in the first 10 s.
    const longRows = rides.filter(({ v }) => v.wallMs >= 30_000).flatMap(({ v }) => v.rows.filter((r) => !r.me));
    const early = longRows.filter((r) => r.jumpMs !== undefined && r.jumpMs < 10_000).length / longRows.length;
    const aboard = riderRows.filter((r) => r.kind === "aboard").length / riderRows.length;
    const nearWall = rides.flatMap(({ v }) => v.rows.filter((r) => !r.me && r.kind === "place" && r.jumpMs !== undefined && v.wallMs - r.jumpMs < 8_000)).length;
    const places = rides.flatMap(({ v }) => v.rows.filter((r) => !r.me && r.kind === "place")).length;
    expect(early).toBeGreaterThan(0.05);
    expect(early).toBeLessThan(0.4);
    expect(aboard).toBeGreaterThan(0.05);
    expect(aboard).toBeLessThan(0.5);
    // The last three off mostly read the last Tell the ride showed: within 8 s of the wall.
    expect(nearWall / places).toBeGreaterThan(0.5);
  });

  it("read a ride without sparks: on such rides most of them still get off, and some Jump on the panel or the screws alone", () => {
    const noSparks = rides.filter(({ p }) => p.ride.sparkAtMs === null);
    expect(noSparks.length).toBeGreaterThan(RIDES / 5);
    const rows = noSparks.flatMap(({ v }) => v.rows.filter((r) => !r.me));
    const off = rows.filter((r) => r.kind !== "aboard").length / rows.length;
    expect(off).toBeGreaterThan(0.5);
    // Some hold for sparks that never come.
    expect(off).toBeLessThan(0.95);
  });

  it("leave a Player who holds to the sparks a real race: most rides fill all three places without them", () => {
    const full = rides.filter(({ v }) => v.rows.filter((r) => r.kind === "place").length === 3).length;
    expect(full / RIDES).toBeGreaterThan(0.8);
  });
});
