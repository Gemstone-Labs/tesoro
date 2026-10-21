import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden.json";
import { decodeRecord } from "./decode";
import { chainState, encodeEvent, freshGame } from "./fixture";
import { move, targets } from "./rules";
import { shownPieces } from "./view";

// Kinds 8-12 are decoded by the chain client ticket.
const POWER_EVENTS = ["blast", "rescue", "dug_in", "pass", "switched"];

describe("fixture accounts", () => {
  it("encodes every event kind so that the decoder gives it back", () => {
    for (const ev of golden.events.filter((x) => !POWER_EVENTS.includes(x.event.kind))) {
      const e = { ...ev.event, seq: ev.seq } as Parameters<typeof encodeEvent>[0];
      expect(decodeRecord(encodeEvent(e))).toEqual(e);
    }
  });

  it("a Match played on the engine reads back through the client's view with the enemy hidden", () => {
    const g0 = freshGame(3, 1_760_000_000_000);
    const us = g0.pieces.find((p) => p.army === "us" && targets(g0, p).length)!;
    const t = targets(g0, us)[0];
    const r = move(g0, { id: us.id, to: t, at: g0.startedAt + 1000 });
    if (!r.ok) throw new Error(r.reason);
    const { battle, armies } = chainState(r.game, g0, r.events);
    const view = shownPieces(battle, armies[0], 0);
    expect(view.find((p) => p.id === us.id)).toMatchObject({ r: t.r, c: t.c, up: true });
    expect(view.filter((p) => p.army === "it").every((p) => !p.up && p.rank === null)).toBe(true);
    expect(battle.turn).toBe(1);
    expect(battle.eventSeq).toBe(r.game.eventSeq);
  });
});
