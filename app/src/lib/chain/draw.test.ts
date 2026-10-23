import { describe, expect, it } from "vitest";
import fixture from "./draw.fixtures.json";
import { decodeStore, freeGemas } from "./basket";
import { planDraw } from "./draw";

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

/**
 * `draw.fixtures.json` is written by the Rust test `app_draw_fixture_matches_plan_draw` (tesoro_core): raw basket and spill
 * accounts built by the program's own code, and the draws `Pool::plan_draw` plans over them. The TypeScript port must decode
 * the same bytes and plan the same draws.
 */
describe("the entry draw preview equals the program's plan_draw (Rust fixture)", () => {
  const basket = decodeStore(bytes(fixture.basket));
  const spill = decodeStore(bytes(fixture.spill));

  it("decodes the program's accounts, with lines in both stores", () => {
    expect(basket.lines.length).toBeGreaterThan(0);
    expect(spill.lines.length).toBeGreaterThan(0);
    expect(freeGemas(basket, spill)).toBe(BigInt(fixture.free));
  });

  for (const c of fixture.cases) {
    it(`plans a ${c.amount} Gema entry line by line like the program`, () => {
      const plan = planDraw(basket, spill, BigInt(c.amount));
      expect(
        plan.steps.map((s) => ({
          side: s.key.side,
          dueAt: Number(s.key.dueAt),
          source: Buffer.from(s.key.source.toBytes()).toString("hex"),
          class: s.key.classId,
          tranche: s.key.tranche,
          take: Number(s.take),
        })),
      ).toEqual(c.steps);
      expect(plan.total).toBe(BigInt(c.amount));
    });
  }

  it("refuses more than the program's free Gemas", () => {
    expect(() => planDraw(basket, spill, BigInt(fixture.free) + 1n)).toThrow();
  });
});
