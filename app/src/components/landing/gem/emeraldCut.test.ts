import { describe, expect, it } from "vitest";
import { EMERALD_CUT, buildEmeraldCut, emeraldCutRings, signedVolume } from "./emeraldCut";

describe("emerald cut geometry", () => {
  const pos = buildEmeraldCut();

  it("has the table fan plus two triangles per facet between rings", () => {
    const rings = emeraldCutRings().length;
    expect(pos.length / 9).toBe(8 + 16 * (rings - 1));
  });

  it("is closed: the area vectors of all faces cancel", () => {
    const sum = [0, 0, 0];
    for (let i = 0; i < pos.length; i += 9) {
      const [ax, ay, az, bx, by, bz, cx, cy, cz] = pos.subarray(i, i + 9);
      const [ux, uy, uz, vx, vy, vz] = [bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az];
      sum[0] += uy * vz - uz * vy;
      sum[1] += uz * vx - ux * vz;
      sum[2] += ux * vy - uy * vx;
    }
    for (const s of sum) expect(Math.abs(s)).toBeLessThan(1e-5);
  });

  it("faces outward", () => {
    expect(signedVolume(pos)).toBeGreaterThan(0);
  });

  it("keeps the cut's proportions: length to width, table, and a keel", () => {
    const xs = [], zs = [];
    for (let i = 0; i < pos.length; i += 3) {
      xs.push(pos[i]);
      zs.push(pos[i + 2]);
    }
    expect(Math.max(...xs) * 2).toBeCloseTo(EMERALD_CUT.ratio, 5);
    expect(Math.max(...zs) * 2).toBeCloseTo(1, 5);
    const [table] = emeraldCutRings();
    expect(Math.max(...table.map((v) => v[2])) * 2).toBeCloseTo(EMERALD_CUT.table, 5);
    const keel = emeraldCutRings().at(-1)!;
    expect(keel.every((v) => Math.abs(v[2]) < 1e-9)).toBe(true);
  });
});
