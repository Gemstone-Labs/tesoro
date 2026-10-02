import * as THREE from "three";

const SIZE = 256;

/**
 * A glow that follows a mark's outline: the geometry's front silhouette, blurred, on a plane `width` x `height`
 * centred on the origin. The plane sits in the mark's mid-plane, so the stone hides it and only the light past
 * its edges shows, from the front and the back alike.
 */
export function outlineGlow(geometry: THREE.BufferGeometry, reach: number) {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  // Three box passes spread the light past `reach`: the margin leaves room for the whole tail, so no edge shows.
  const width = Math.max(-box.min.x, box.max.x) * 2 + reach * 3.4;
  const height = Math.max(-box.min.y, box.max.y) * 2 + reach * 3.4;
  const scale = SIZE / Math.max(width, height);
  const [w, h] = [Math.round(width * scale), Math.round(height * scale)];

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;
  g.fillStyle = g.strokeStyle = "#fff";
  const pos = geometry.getAttribute("position");
  const px = (i: number) => w / 2 + pos.getX(i) * scale;
  const py = (i: number) => h / 2 - pos.getY(i) * scale;
  for (let i = 0; i < pos.count; i += 3) {
    g.beginPath();
    g.moveTo(px(i), py(i));
    g.lineTo(px(i + 1), py(i + 1));
    g.lineTo(px(i + 2), py(i + 2));
    g.closePath();
    g.fill();
    g.stroke();
  }

  const image = g.getImageData(0, 0, w, h);
  const alpha = new Float32Array(w * h);
  for (let i = 0; i < alpha.length; i++) alpha[i] = image.data[i * 4 + 3] / 255;
  // Three box blurs approximate a gaussian.
  const radius = Math.max(1, Math.round((reach * scale) / 2.2));
  for (let pass = 0; pass < 3; pass++) {
    boxBlur(alpha, w, h, radius, 1, w);
    boxBlur(alpha, h, w, radius, w, 1);
  }
  for (let i = 0; i < alpha.length; i++) {
    image.data[i * 4] = image.data[i * 4 + 1] = image.data[i * 4 + 2] = 255;
    // Eased so the light lingers near the edge and fades out slowly, dithered against banding in the dark tail.
    const a = 1 - (1 - alpha[i]) ** 2;
    image.data[i * 4 + 3] = a > 0.002 ? a * 255 + Math.random() - 0.5 : 0;
  }
  g.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return { texture, width, height };
}

/** One box blur along rows of `n` samples (`step` apart), `lines` of them (`stride` apart), in place. */
function boxBlur(a: Float32Array, n: number, lines: number, r: number, step: number, stride: number) {
  const row = new Float32Array(n);
  for (let l = 0; l < lines; l++) {
    const base = l * stride;
    for (let i = 0; i < n; i++) row[i] = a[base + i * step];
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += row[Math.min(n - 1, Math.max(0, i))];
    for (let i = 0; i < n; i++) {
      a[base + i * step] = sum / (2 * r + 1);
      sum += row[Math.min(n - 1, i + r + 1)] - row[Math.max(0, i - r)];
    }
  }
}
