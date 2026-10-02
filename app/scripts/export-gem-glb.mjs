/**
 * Exports the landing page's emerald-cut Gema (the same procedural mesh the page renders) as a binary glTF:
 * public/art/landing/gema.glb, 14.5 × 10 mm, flat-faceted, with a transmissive emerald material
 * (KHR_materials_transmission / ior / volume), so it opens in Blender and other tools as a real gem.
 *
 *   node scripts/export-gem-glb.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEmeraldCut } from "../src/components/landing/gem/emeraldCut.ts";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../public/art/landing/gema.glb");

const pos = buildEmeraldCut();
const normals = new Float32Array(pos.length);
for (let i = 0; i < pos.length; i += 9) {
  const [ax, ay, az, bx, by, bz, cx, cy, cz] = pos.subarray(i, i + 9);
  const [ux, uy, uz, vx, vy, vz] = [bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az];
  let n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  const len = Math.hypot(...n) || 1;
  n = n.map((c) => c / len);
  for (let k = 0; k < 3; k++) normals.set(n, i + k * 3);
}

const count = pos.length / 3;
const min = [0, 1, 2].map((a) => Math.min(...pos.filter((_, i) => i % 3 === a)));
const max = [0, 1, 2].map((a) => Math.max(...pos.filter((_, i) => i % 3 === a)));
const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(normals.buffer)]);

const gltf = {
  asset: { version: "2.0", generator: "tesoro scripts/export-gem-glb.mjs" },
  extensionsUsed: ["KHR_materials_transmission", "KHR_materials_ior", "KHR_materials_volume"],
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: "Gema", mesh: 0, scale: [0.01, 0.01, 0.01] }],
  meshes: [{ name: "EmeraldCut", primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }] }],
  materials: [
    {
      name: "Emerald",
      pbrMetallicRoughness: { baseColorFactor: [0.14, 0.85, 0.66, 1], metallicFactor: 0, roughnessFactor: 0.02 },
      extensions: {
        KHR_materials_transmission: { transmissionFactor: 1 },
        KHR_materials_ior: { ior: 1.57 },
        KHR_materials_volume: { thicknessFactor: 1, attenuationDistance: 0.6, attenuationColor: [0.04, 0.49, 0.36] },
      },
    },
  ],
  buffers: [{ byteLength: bin.length }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
    { buffer: 0, byteOffset: pos.byteLength, byteLength: normals.byteLength, target: 34962 },
  ],
  accessors: [
    { bufferView: 0, componentType: 5126, count, type: "VEC3", min, max },
    { bufferView: 1, componentType: 5126, count, type: "VEC3" },
  ],
};

const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
const json = pad(Buffer.from(JSON.stringify(gltf)), 0x20);
const data = pad(bin, 0);
const chunk = (type, body) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(body.length, 0);
  h.writeUInt32LE(type, 4);
  return Buffer.concat([h, body]);
};
const body = Buffer.concat([chunk(0x4e4f534a, json), chunk(0x004e4942, data)]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + body.length, 8);
writeFileSync(OUT, Buffer.concat([header, body]));
console.log(`${OUT} (${count / 3} triangles)`);
