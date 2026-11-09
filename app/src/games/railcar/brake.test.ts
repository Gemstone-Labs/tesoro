import { describe, expect, it } from "vitest";
import { BIND_PER_SEND, bindTargets, brakeState, earlyCopyDue, pageSend, tellCues, type BrakeFacts } from "./brake";
import type { TableView } from "./chain";

const table = (o: Partial<TableView>): TableView => ({ phase: "drawing", seated: 12, brakesBound: 0, ...o }) as TableView;

describe("binding every seat during the draw", () => {
  it("a page binds its own seat and the next ones, wrapping past the last", () => {
    expect(bindTargets(table({}), 3)).toEqual([3, 4, 5, 6, 7]);
    expect(bindTargets(table({}), 10)).toEqual([10, 11, 0, 1, 2]);
    expect(BIND_PER_SEND).toBe(5);
  });

  it("a small car: each seat once", () => {
    expect(bindTargets(table({ seated: 3 }), 2)).toEqual([2, 0, 1]);
  });

  it("nothing once every seat is bound, outside the draw and the ride, or for a page with no seat", () => {
    expect(bindTargets(table({ brakesBound: 12 }), 3)).toEqual([]);
    expect(bindTargets(table({ phase: "over" }), 3)).toEqual([]);
    expect(bindTargets(table({ phase: "idle" }), 3)).toEqual([]);
    expect(bindTargets(table({ phase: "riding", brakesBound: 11 }), 3)).toEqual([3, 4, 5, 6, 7]);
    expect(bindTargets(table({}), null)).toEqual([]);
  });
});

describe("the Brake button", () => {
  const ready: BrakeFacts = { aboard: true, allBound: true, myBound: true, canSign: true, walletCopied: true, pressMs: null, pending: false, rideMs: 40_000 };

  it("ready: one left", () => {
    expect(brakeState(ready)).toEqual({ status: "ready", left: 1, activeMs: 0 });
  });

  it("pressed: it rides on the next tick, then my 5 s count down, then it is used", () => {
    expect(brakeState({ ...ready, pending: true })).toEqual({ status: "sending", left: 0, activeMs: 0 });
    expect(brakeState({ ...ready, pressMs: 38_000 })).toEqual({ status: "on", left: 0, activeMs: 3_000 });
    expect(brakeState({ ...ready, pressMs: 30_000 })).toEqual({ status: "used", left: 0, activeMs: 0 });
  });

  it("waits until every seat is bound and mine can be signed for", () => {
    expect(brakeState({ ...ready, allBound: false })?.status).toBe("waiting");
    expect(brakeState({ ...ready, myBound: false })?.status).toBe("waiting");
    expect(brakeState({ ...ready, canSign: false })?.status).toBe("waiting");
  });

  it("on the wallet route the Brake waits for the early copy: until it landed the button asks to sign, so the Brake is never the wallet's first ride transaction", () => {
    expect(brakeState({ ...ready, walletCopied: false })?.status).toBe("sign");
    expect(brakeState({ ...ready, walletCopied: true })?.status).toBe("ready");
    // still waiting for the seats: that comes first
    expect(brakeState({ ...ready, walletCopied: false, allBound: false })?.status).toBe("waiting");
  });

  it("none off the car", () => {
    expect(brakeState({ ...ready, aboard: false })).toBeNull();
  });
});

describe("the wallet's early copy (founder 2026-11-08)", () => {
  const due = { route: "wallet" as const, riding: true, aboard: true, copy: "none" as const };
  it("a page on the wallet route sends it as the ride starts, once; a seat-key page never does", () => {
    expect(earlyCopyDue(due)).toBe(true);
    expect(earlyCopyDue({ ...due, route: "next-tick" })).toBe(false);
    expect(earlyCopyDue({ ...due, route: null })).toBe(false);
  });

  it("not before the ride starts, not off the car, and never twice (a declined prompt is asked again only from the button)", () => {
    expect(earlyCopyDue({ ...due, riding: false })).toBe(false);
    expect(earlyCopyDue({ ...due, aboard: false })).toBe(false);
    expect(earlyCopyDue({ ...due, copy: "asking" })).toBe(false);
    expect(earlyCopyDue({ ...due, copy: "done" })).toBe(false);
    expect(earlyCopyDue({ ...due, copy: "declined" })).toBe(false);
  });
});

describe("what a page sends while the ride runs", () => {
  it("an aboard Player whose seat is bound ticks (the Brake rides on it); anyone else signals", () => {
    expect(pageSend({ aboard: true, myBound: true, canSign: true })).toBe("tick");
    expect(pageSend({ aboard: true, myBound: false, canSign: true })).toBe("signal");
    expect(pageSend({ aboard: true, myBound: true, canSign: false })).toBe("signal");
    expect(pageSend({ aboard: false, myBound: true, canSign: true })).toBe("signal");
  });
});

describe("Tells as sound and touch", () => {
  it("each new stage and each false screw cues once; nothing for a stage already passed", () => {
    expect(tellCues(null, { tell: 0, falseScrews: 0 })).toEqual([]);
    expect(tellCues({ tell: 0, falseScrews: 0 }, { tell: 0, falseScrews: 1 })).toEqual(["screws"]);
    expect(tellCues({ tell: 0, falseScrews: 1 }, { tell: 1, falseScrews: 1 })).toEqual(["screws"]);
    expect(tellCues({ tell: 1, falseScrews: 1 }, { tell: 2, falseScrews: 1 })).toEqual(["rattle"]);
    expect(tellCues({ tell: 2, falseScrews: 1 }, { tell: 3, falseScrews: 1 })).toEqual(["sparks"]);
    expect(tellCues({ tell: 3, falseScrews: 1 }, { tell: 3, falseScrews: 1 })).toEqual([]);
  });

  it("a page that opens mid-ride does not replay what already passed", () => {
    expect(tellCues(null, { tell: 2, falseScrews: 3 })).toEqual([]);
  });

  it("two stages passed between reads cue both, in order", () => {
    expect(tellCues({ tell: 1, falseScrews: 0 }, { tell: 3, falseScrews: 0 })).toEqual(["rattle", "sparks"]);
  });
});
