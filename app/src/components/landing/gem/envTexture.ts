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
  sky.addColorStop(0, "#3a4a52");
  sky.addColorStop(0.45, "#121b1f");
  sky.addColorStop(0.75, "#0a2a22");
  sky.addColorStop(1, "#14a37c");
  g.fillStyle = sky;
  g.fillRect(0, 0, w, h);
  const box = (x: number, y: number, bw: number, bh: number, color: string, blur = 6) => {
    g.save();
    g.filter = `blur(${blur}px)`;
    g.fillStyle = color;
    g.fillRect(x * w, y * h, bw * w, bh * h);
    g.restore();
  };
  box(0.22, 0.03, 0.56, 0.1, "#ffffff", 4);
  box(0.05, 0.26, 0.07, 0.34, "#f4fffb");
  box(0.55, 0.26, 0.07, 0.34, "#f4fffb");
  box(0.3, 0.3, 0.16, 0.12, "#e6fff7", 6);
  box(0.8, 0.22, 0.12, 0.26, "#cfe3ea", 10);
  box(0.0, 0.62, 1, 0.05, "#7ff5d2", 8);
  box(0.0, 0.86, 1, 0.14, "#3ff0c0", 18);
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
