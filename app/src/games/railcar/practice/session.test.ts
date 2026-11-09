import { describe, expect, it } from "vitest";
import { impactMs, positionMs, refund, ride } from "../engine";
import { newPractice, practiceBrake, practiceJump, practiceView, simRiders, type PracticeRider } from "./session";

/** All zeros: the engine's longest ride (crash at 120 s; screws at 1:40, panel at 1:52, sparks at 1:57). */
const LONG = new Uint8Array(32);
const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (n * 131 + i * 17 + ((n >> 3) ^ i)) & 0xff);

const rider = (name: string, planMs: number): PracticeRider => ({ id: `practice:${name}`, name, planMs, boltReactMs: null, sparkReactMs: null });
const NEVER = 1_000_000;

type Result = Extract<ReturnType<typeof practiceView>, { phase: "result" }>;
const result = (v: ReturnType<typeof practiceView>): Result => {
  if (v.phase !== "result") throw new Error(`expected the Result, got ${v.phase}`);
  return v;
};
const gets = (v: Result) => Object.fromEntries(v.rows.map((r) => [r.me ? "You" : r.name, Number(r.gets)]));

describe("a Practice ride pays what a 500 entry would have", () => {
  it("the spec's worked example, as Dee: 813 / 630 / 578 / 350 / 0, fees 129", () => {
    // Ana Jumps at 25 s, Cy, Ben, then Dee (you) at 95-100 s; Eve stays aboard.
    let p = newPractice(LONG, [rider("Ana", 25_000), rider("Ben", 97_000), rider("Cy", 95_000), rider("Eve", NEVER)]);
    p = practiceJump(p, 99_000);
    const v = result(practiceView(p, 120_000));
    expect(gets(v)).toEqual({ You: 813, Ben: 630, Cy: 578, Ana: 350, Eve: 0 });
    expect(Number(v.fees)).toBe(129);
    expect(v.mine).toMatchObject({ headline: "Last off", gets: 813n, won: 313n });
    expect(v.wallMs).toBe(120_000);
  });

  it("ten aboard: one early Jump at 25 s, three placed, six aboard at Impact", () => {
    // Pot 5,000; 350 back to Ana; fees 6% of 4,650 = 279; 3,150 forfeited - 279 = 2,871 split 1,724 / 717 / 430.
    let p = newPractice(LONG, [rider("Ana", 25_000), rider("Ben", 97_000), rider("Cy", 95_000), ...["Eve", "Fin", "Gus", "Hal", "Ivy", "Jo"].map((n) => rider(n, NEVER))]);
    p = practiceJump(p, 99_000);
    const v = result(practiceView(p, 120_000));
    expect(gets(v)).toMatchObject({ You: 2_224, Ben: 1_217, Cy: 930, Ana: 350, Eve: 0, Jo: 0 });
    expect(Number(v.fees)).toBe(279);
    expect(Number(v.pot)).toBe(5_000);
    expect(v.rows.reduce((a, r) => a + Number(r.gets), 0) + Number(v.fees)).toBe(5_000);
  });

  it("you aboard at Impact get nothing; a Jump after Impact counts as aboard", () => {
    let p = newPractice(LONG, [rider("Ana", 25_000), rider("Ben", 97_000), rider("Cy", 95_000), rider("Dee", 99_000)]);
    p = practiceJump(p, 120_000);
    const v = result(practiceView(p, 121_000));
    expect(v.mine).toMatchObject({ headline: "Aboard at Impact", gets: 0n });
    expect(gets(v)).toMatchObject({ Dee: 813, Ben: 630, Cy: 578, Ana: 350, You: 0 });
  });

  it("nobody Jumps: every entry back, no fees", () => {
    const v = result(practiceView(newPractice(LONG, [rider("Ana", NEVER), rider("Ben", NEVER)]), 120_000));
    expect(v.outcome).toBe("refund");
    expect(v.mine).toMatchObject({ headline: "Nobody jumped", gets: 500n });
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
      const before = (ms: number) => practiceView(a, ms - 1);
      const at = (ms: number) => practiceView(a, ms);
      // Each Tell stage shows at its engine position (no Brake: real ms = track ms).
      for (const [stage, ms] of [[1, r.screwAtMs], [2, r.boltAtMs], [3, r.sparkAtMs]] as const) {
        if (ms === 0) continue;
        const b = before(ms);
        const v = at(ms);
        if (b.phase === "ride") expect(b.tell).toBe(stage - 1);
        if (v.phase === "ride") expect(v.tell).toBe(stage);
      }
      expect(at(r.crashMs - 1).phase).toBe("ride");
      expect(result(at(r.crashMs)).wallMs).toBe(r.crashMs);
    }
  });

  it("my Brake halves the car for 5 s: Impact moves by the engine's rule, and an early Jump is refunded by track position", () => {
    const s = seed(9);
    const r = ride(s);
    let p = newPractice(s, [rider("Ana", NEVER)]);
    p = practiceBrake(p, 4_000);
    expect(practiceBrake(p, 6_000)).toEqual(p);
    expect(result(practiceView(p, impactMs([4_000], r.crashMs))).wallMs).toBe(impactMs([4_000], r.crashMs));
    expect(practiceView(p, impactMs([4_000], r.crashMs) - 1).phase).toBe("ride");
    p = practiceJump(p, 8_000);
    const v = practiceView(p, 8_500);
    expect(v.phase === "ride" && v.me).toMatchObject({ aboard: false, jumpMs: 8_000, back: refund(500n, positionMs([4_000], 8_000)) });
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
    // On rides of a minute or more, a few riders are off in the first 20 s.
    const longRows = rides.filter(({ v }) => v.wallMs >= 60_000).flatMap(({ v }) => v.rows.filter((r) => !r.me));
    const early = longRows.filter((r) => r.jumpMs !== undefined && r.jumpMs < 20_000).length / longRows.length;
    const aboard = riderRows.filter((r) => r.kind === "aboard").length / riderRows.length;
    const nearWall = rides.flatMap(({ v }) => v.rows.filter((r) => !r.me && r.kind === "place" && r.jumpMs !== undefined && v.wallMs - r.jumpMs < 8_000)).length;
    const places = rides.flatMap(({ v }) => v.rows.filter((r) => !r.me && r.kind === "place")).length;
    expect(early).toBeGreaterThan(0.05);
    expect(early).toBeLessThan(0.4);
    expect(aboard).toBeGreaterThan(0.05);
    expect(aboard).toBeLessThan(0.5);
    // The last three off mostly read the sparks: within 8 s of the wall.
    expect(nearWall / places).toBeGreaterThan(0.5);
  });

  it("leave a Player who holds to the sparks a real race: most rides fill all three places without them", () => {
    const full = rides.filter(({ v }) => v.rows.filter((r) => r.kind === "place").length === 3).length;
    expect(full / RIDES).toBeGreaterThan(0.8);
  });
});
