import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { signedVolume } from "../gem/emeraldCut";
import { CHAINS } from "./layout";
import { chainLogo } from "./logos";

describe.each(CHAINS.map((c) => c.label))("%s mark geometry", (label) => {
  const g = chainLogo[label]();
  const pos = g.getAttribute("position").array as Float32Array;

  it("is one ungrouped, non-indexed solid (the refraction material traces a single BVH root)", () => {
    expect(g.index).toBeNull();
    expect(g.groups).toHaveLength(0);
    expect(pos.length % 9).toBe(0);
  });

  it("is closed and faces outward", () => {
    const sum = new THREE.Vector3();
    const [a, b, c] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    for (let i = 0; i < pos.length; i += 9) {
      a.fromArray(pos, i);
      sum.add(b.fromArray(pos, i + 3).sub(a).cross(c.fromArray(pos, i + 6).sub(a)));
    }
    expect(sum.length()).toBeLessThan(1e-4);
    expect(signedVolume(pos)).toBeGreaterThan(0);
  });

  it("is about one unit across and centred", () => {
    g.computeBoundingBox();
    const size = g.boundingBox!.getSize(new THREE.Vector3());
    const centre = g.boundingBox!.getCenter(new THREE.Vector3());
    expect(Math.max(size.x, size.y)).toBeGreaterThan(0.9);
    expect(Math.max(size.x, size.y)).toBeLessThan(1.25);
    expect(centre.length()).toBeLessThan(0.02);
  });
});
