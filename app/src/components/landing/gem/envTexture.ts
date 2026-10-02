import * as THREE from "three";

/**
 * A procedural studio environment as an equirect texture: dark surround, rectangular softboxes
 * (the crisp highlights an emerald cut needs) and a faint emerald under-fill. No HDR download.
 */
export function studioEnvironment(): THREE.Texture {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;
  const sky = g.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#5a6d75");
  sky.addColorStop(0.4, "#24343a");
  sky.addColorStop(0.7, "#0d3a2e");
  sky.addColorStop(1, "#1fc497");
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  const box = (x: number, y: number, bw: number, bh: number, color: string, blur = 4) => {
    g.save();
    g.filter = `blur(${blur}px)`;
    g.fillStyle = color;
    g.fillRect(x * w, y * h, bw * w, bh * h);
    g.restore();
  };
  // Long softbox strips: each stepped facet catches one as a crisp white band.
  box(0.15, 0.02, 0.7, 0.08, "#ffffff", 3);
  box(0.2, 0.15, 0.6, 0.035, "#ffffff", 2);
  box(0.25, 0.24, 0.5, 0.025, "#e9fffa", 2);
  box(0.04, 0.22, 0.06, 0.4, "#ffffff", 3);
  box(0.54, 0.22, 0.06, 0.4, "#ffffff", 3);
  box(0.29, 0.3, 0.03, 0.3, "#f2fffb", 2);
  box(0.79, 0.3, 0.03, 0.3, "#f2fffb", 2);
  box(0.36, 0.36, 0.16, 0.1, "#dffaf1", 6);
  box(0.0, 0.6, 1, 0.04, "#9ff9de", 6);
  box(0.0, 0.84, 1, 0.16, "#48f2c4", 14);
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
