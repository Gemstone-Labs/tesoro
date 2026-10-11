"use client";

import { useEffect, useRef } from "react";
import { INSET, LINES } from "../geometry";
import { dividerScene } from "../dividers/octa";
import { TEXTURES, type Pt, type Texture } from "./textures";

const key = (p: Pt) => `${Math.round(p[0])},${Math.round(p[1])}`;
const mod = (n: number, m: number) => ((n % m) + m) % m;
const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/* Every segment of a pattern, keyed by its tile-wrapped end; neighbours are stored relative to that wrapped end. */
function graph(tex: Texture, TW: number, TH: number) {
  const segs: [Pt, Pt][] = [...tex.lines];
  for (const poly of tex.polys) poly.forEach((p, i) => segs.push([p, poly[(i + 1) % poly.length]]));
  const adj = new Map<string, Pt[]>();
  const add = (a: Pt, b: Pt) => {
    const dx = a[0] - mod(a[0], TW), dy = a[1] - mod(a[1], TH);
    const k = key([a[0] - dx, a[1] - dy]);
    adj.set(k, [...(adj.get(k) ?? []), [b[0] - dx, b[1] - dy]]);
  };
  for (const [a, b] of segs) { add(a, b); add(b, a); }
  return adj;
}

/* A light running along the pattern's lines: a head and a short trail, at a steady speed. */
type Pulse = { ox: number; oy: number; a: Pt; b: Pt; t: number; life: number; trail: Pt[] };
const SPEED = 150; // px/s
const TRAIL = 16; // samples

export function LivingTexture({ tex = "0" }: { tex?: string }) {
  const cv = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const pattern = TEXTURES[tex] ?? TEXTURES["0"];
    const [TW, TH] = pattern.size ?? [360, 360];
    const adj = graph(pattern, TW, TH);
    const nodes = pattern.polys[0];
    const canvas = cv.current;
    const wl = canvas?.closest<HTMLElement>(".wl");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !wl || !ctx) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0, H = 0, dpr = 1;
    // The diagonal and its unit normal pointing into the wall: lights travel along it and fade as they reach the divider.
    let lx = 0, ly = 0, nx = 1, ny = 0;
    const toWall = (x: number, y: number) => (x - lx) * nx + (y - ly) * ny;
    const mask = document.createElement("canvas");
    const mctx = mask.getContext("2d")!;

    const build = () => {
      const r = wl.getBoundingClientRect();
      W = r.width; H = r.height; dpr = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = mask.width = Math.round(W * dpr);
      canvas.height = mask.height = Math.round(H * dpr);
      const kind = matchMedia("(max-width: 640px)").matches ? "tall" : "wide";
      const l = LINES[kind];
      lx = l.x1 * W; ly = l.y1 * H;
      const dx = (l.x2 - l.x1) * W, dy = (l.y2 - l.y1) * H, len = Math.hypot(dx, dy);
      nx = dy / len; ny = -dx / len;
      if (toWall(W, 0) < 0) { nx = -nx; ny = -ny; } // the wall holds the top-right corner

      mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      mctx.clearRect(0, 0, W, H);
      mctx.lineWidth = 1.4;
      mctx.strokeStyle = "#fff";
      mctx.fillStyle = "rgba(255,255,255,.16)"; // the cell itself lights faintly
      for (let i = -1; i * TW < W + TW; i++) for (let j = -1; j * TH < H + TH; j++) {
        mctx.save();
        mctx.translate(i * TW, j * TH);
        pattern.polys.forEach((poly, n) => {
          mctx.beginPath();
          poly.forEach(([x, y], k) => (k ? mctx.lineTo(x, y) : mctx.moveTo(x, y)));
          mctx.closePath();
          if (n % 2 === 0) mctx.fill();
          mctx.stroke();
        });
        mctx.beginPath();
        for (const [a, b] of pattern.lines) {
          mctx.moveTo(a[0], a[1]);
          mctx.lineTo(b[0], b[1]);
        }
        mctx.stroke();
        mctx.restore();
      }
      // Light only the panel: the floor plus the divider's ground and gems, which sit over the floor's inset edge.
      const ix = kind === "wide" ? INSET.wide : 0, iy = kind === "tall" ? INSET.tall : 0;
      const floor = new Path2D();
      floor.moveTo(l.x1 * W - ix, l.y1 * H + iy);
      floor.lineTo(l.x2 * W - ix, l.y2 * H + iy);
      if (l.y2 < 1) floor.lineTo(W, H);
      floor.lineTo(0, H);
      if (l.y1 <= 0) floor.lineTo(0, 0);
      floor.closePath();
      const { ground, gems } = dividerScene({ w: wl.clientWidth, h: wl.clientHeight, kind });
      const shape = document.createElement("canvas");
      shape.width = mask.width; shape.height = mask.height;
      const sctx = shape.getContext("2d")!;
      sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const path of [floor, new Path2D(ground), new Path2D(gems)]) sctx.fill(path);
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.globalCompositeOperation = "destination-in";
      mctx.drawImage(shape, 0, 0);
      mctx.globalCompositeOperation = "source-over";
    };
    build();
    const ro = new ResizeObserver(build);
    ro.observe(wl);

    const cursor = { x: -999, y: -999, s: 0, on: false };
    const focus = { s: 0, on: false };
    const pulses: Pulse[] = [];
    // Of the lines leaving a node, the one heading most directly at the divider. Never straight back.
    const next = (at: Pt, from: Pt) => {
      let best: Pt | null = null, score = -Infinity;
      for (const q of adj.get(key(at)) ?? []) {
        if (key(q) === key(from)) continue;
        const dx = q[0] - at[0], dy = q[1] - at[1], len = Math.hypot(dx, dy) || 1;
        const sc = (dx * nx + dy * ny) / len;
        if (sc > score) { score = sc; best = q; }
      }
      return best;
    };
    const spawn = (x: number, y: number) => {
      const i = Math.floor(x / TW), j = Math.floor(y / TH);
      const px = x - i * TW, py = y - j * TH;
      const a = nodes.reduce((m, p) => (Math.hypot(p[0] - px, p[1] - py) < Math.hypot(m[0] - px, m[1] - py) ? p : m));
      const w: Pt = [mod(a[0], TW), mod(a[1], TH)];
      const b = next(w, [NaN, NaN]);
      if (!b) return;
      pulses.push({ ox: i * TW + a[0] - w[0], oy: j * TH + a[1] - w[1], a: w, b, t: 0, life: 0, trail: [] });
    };
    const step = (p: Pulse, d: number) => {
      p.t += d / Math.max(Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]), 1);
      while (p.t >= 1) {
        // re-anchor on the tile that holds the node just reached, so links carry on into the next tile
        const dx = p.b[0] - mod(p.b[0], TW), dy = p.b[1] - mod(p.b[1], TH);
        p.ox += dx; p.oy += dy;
        const at: Pt = [p.b[0] - dx, p.b[1] - dy];
        const from: Pt = [p.a[0] - dx, p.a[1] - dy];
        const to = next(at, from);
        if (!to) return false;
        const done = (p.t - 1) * Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
        p.a = at; p.b = to;
        p.t = done / Math.max(Math.hypot(to[0] - at[0], to[1] - at[1]), 1);
      }
      return true;
    };

    const onMove = (e: PointerEvent) => {
      const r = wl.getBoundingClientRect();
      cursor.x = e.clientX - r.left; cursor.y = e.clientY - r.top; cursor.on = e.pointerType !== "touch";
    };
    const onLeave = () => (cursor.on = false);
    const form = () => wl.querySelector<HTMLElement>(".wl-form");
    const onFocusIn = (e: FocusEvent) => (focus.on = (e.target as HTMLElement).id === "wl-email" || focus.on);
    const onFocusOut = (e: FocusEvent) => (e.target as HTMLElement).id === "wl-email" && (focus.on = false);
    addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);
    wl.addEventListener("focusin", onFocusIn);
    wl.addEventListener("focusout", onFocusOut);

    const blob = (x: number, y: number, r: number, a: number) => {
      if (a <= 0.003) return;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    };

    let last = performance.now(), acc = 0, raf = 0;
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      cursor.s += ((cursor.on ? 1 : 0) - cursor.s) * Math.min(1, dt * 6);
      focus.s += ((focus.on ? 1 : 0) - focus.s) * Math.min(1, dt * 4);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (still) blob(W * 0.17, H * 0.26, 260, 0.5);
      else {
        // A soft band parallel to the divider, easing from the far corner up to it, fading in and out on the way.
        const far = Math.min(toWall(0, H), toWall(0, 0));
        const u = (now / 1000 / 11) % 1;
        const e = u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2;
        const d = far - 160 + (160 - far) * e;
        const a = 0.34 * Math.sin(Math.PI * u);
        if (a > 0.01) {
          const g = ctx.createLinearGradient(lx + nx * (d - 140), ly + ny * (d - 140), lx + nx * (d + 140), ly + ny * (d + 140));
          g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, `rgba(255,255,255,${a})`); g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        }
        // an ambient wash so there is always something lit, plus the cursor
        blob(W * 0.2 + Math.sin(now / 5200) * 90, H * 0.28 + Math.cos(now / 6100) * 50, 260, 0.3);
        if (cursor.s > 0.01) blob(cursor.x, cursor.y, 240, 0.95 * cursor.s);
        const f = form()?.getBoundingClientRect();
        const r = wl.getBoundingClientRect();
        if (f && focus.s > 0.01) blob(f.left - r.left + f.width / 2, f.top - r.top + f.height / 2, 330, 0.75 * focus.s);
        acc += dt * (0.8 + focus.s * 2.2);
        while (acc > 1 && pulses.length < 9) {
          acc -= 1;
          if (focus.s > 0.3 && f) spawn(f.left - r.left + Math.random() * f.width, f.top - r.top - 20 - Math.random() * 120);
          else spawn(30 + Math.random() * W * 0.32, 70 + Math.random() * H * 0.75);
        }
        acc = Math.min(acc, 1);
        for (let k = pulses.length - 1; k >= 0; k--) {
          const p = pulses[k];
          p.life += dt;
          const alive = step(p, SPEED * dt);
          const x = p.ox + p.a[0] + (p.b[0] - p.a[0]) * p.t, y = p.oy + p.a[1] + (p.b[1] - p.a[1]) * p.t;
          p.trail.unshift([x, y]);
          if (p.trail.length > TRAIL) p.trail.pop();
          // fade in over half a second, fade out across the divider's band (its last 180px), or at the end of a line
          const fade = smooth(p.life / 0.5) * smooth((40 - toWall(x, y)) / 180) * (alive ? 1 : 0) * smooth((7 - p.life) / 1);
          if (fade <= 0.003) { pulses.splice(k, 1); continue; }
          p.trail.forEach(([tx, ty], n) => blob(tx, ty, n ? 34 : 44, fade * (n ? 0.5 * (1 - n / TRAIL) : 0.9)));
        }
      }
      ctx.globalCompositeOperation = "destination-in";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(mask, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      if (tex !== "0") {
        // the pattern itself, at the CSS texture's strength (the CSS one is hidden while a new pattern is on)
        ctx.globalAlpha = 0.05;
        ctx.drawImage(mask, 0, 0);
        ctx.globalAlpha = 1;
      }
      if (!still) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    if (tex !== "0") wl.dataset.tex = tex;

    return () => {
      delete wl.dataset.tex;
      cancelAnimationFrame(raf);
      ro.disconnect();
      removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      wl.removeEventListener("focusin", onFocusIn);
      wl.removeEventListener("focusout", onFocusOut);
    };
  }, [tex]);

  return <canvas ref={cv} className="pl-d-cv" aria-hidden />;
}
