"use client";

import { useEffect, useRef } from "react";
import { INSET, LINES } from "../geometry";
import { dividerScene } from "../dividers/octa";

import { TEXTURES, type Pt, type Texture } from "./textures";

const T = 360;
const key = (p: Pt) => `${Math.round(p[0])},${Math.round(p[1])}`;
const wrap = (n: number) => ((n % T) + T) % T;

/* Every segment of a pattern, keyed by its tile-wrapped end; neighbours are stored relative to that wrapped end. */
function graph(tex: Texture) {
  const segs: [Pt, Pt][] = [...tex.lines];
  for (const poly of tex.polys) poly.forEach((p, i) => segs.push([p, poly[(i + 1) % poly.length]]));
  const adj = new Map<string, Pt[]>();
  const add = (a: Pt, b: Pt) => {
    const dx = a[0] - wrap(a[0]), dy = a[1] - wrap(a[1]);
    const k = key([wrap(a[0]), wrap(a[1])]);
    adj.set(k, [...(adj.get(k) ?? []), [b[0] - dx, b[1] - dy]]);
  };
  for (const [a, b] of segs) { add(a, b); add(b, a); }
  const nodes = tex.polys[0];
  return { adj, nodes };
}

type Pulse = { ox: number; oy: number; a: [number, number]; b: [number, number]; t: number; life: number };

export function LivingTexture({ tex = "0" }: { tex?: string }) {
  const cv = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const pattern = TEXTURES[tex] ?? TEXTURES["0"];
    const { adj, nodes } = graph(pattern);
    const canvas = cv.current;
    const wl = canvas?.closest<HTMLElement>(".wl");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !wl || !ctx) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let W = 0, H = 0, dpr = 1;
    const mask = document.createElement("canvas");
    const mctx = mask.getContext("2d")!;

    const build = () => {
      const r = wl.getBoundingClientRect();
      W = r.width; H = r.height; dpr = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = mask.width = Math.round(W * dpr);
      canvas.height = mask.height = Math.round(H * dpr);
      mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      mctx.clearRect(0, 0, W, H);
      mctx.lineWidth = 1.4;
      for (let i = -1; i * T < W + T; i++) for (let j = -1; j * T < H + T; j++) {
        mctx.save();
        mctx.translate(i * T, j * T);
        pattern.polys.forEach((poly, n) => {
          mctx.beginPath();
          poly.forEach(([x, y], k) => (k ? mctx.lineTo(x, y) : mctx.moveTo(x, y)));
          mctx.closePath();
          if (n === 0 || pattern.name === "Tiled floor") {
            mctx.fillStyle = "rgba(255,255,255,.16)"; // the cell itself lights faintly
            if (n % 2 === 0) mctx.fill();
          }
          mctx.strokeStyle = "#fff";
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
      const kind = matchMedia("(max-width: 640px)").matches ? "tall" : "wide";
      const l = LINES[kind];
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
    const spawn = (x: number, y: number) => {
      const i = Math.floor(x / T), j = Math.floor(y / T);
      const lx = x - i * T, ly = y - j * T;
      // the closest vertex of the main outline to the point
      const a = nodes.reduce((m, p) => (Math.hypot(p[0] - lx, p[1] - ly) < Math.hypot(m[0] - lx, m[1] - ly) ? p : m));
      const w: Pt = [wrap(a[0]), wrap(a[1])];
      const n = adj.get(key(w));
      if (!n) return;
      const b = n.reduce((m, p) => (p[0] > m[0] ? p : m));
      pulses.push({ ox: i * T + a[0] - w[0], oy: j * T + a[1] - w[1], a: w, b, t: 0, life: 0 });
    };
    const step = (p: Pulse, d: number) => {
      let len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
      p.t += d / Math.max(len, 1);
      while (p.t >= 1) {
        // re-anchor on the tile that holds the node just reached, so links carry on into the next tile
        const dx = p.b[0] - wrap(p.b[0]), dy = p.b[1] - wrap(p.b[1]);
        p.ox += dx; p.oy += dy;
        const at: Pt = [p.b[0] - dx, p.b[1] - dy];
        const from: Pt = [p.a[0] - dx, p.a[1] - dy];
        const opts = (adj.get(key(at)) ?? []).filter((q) => key(q) !== key(from));
        if (!opts.length) return false;
        // lean towards the divider (right), with some wandering
        const pick = Math.random() < 0.8 ? opts.reduce((m, q) => (q[0] - at[0] > m[0] - at[0] ? q : m)) : opts[Math.floor(Math.random() * opts.length)];
        p.t -= 1;
        p.a = at; p.b = pick;
        len = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]);
        p.t = Math.min(p.t, 0.99);
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
        // a soft band of light sweeping towards the divider, parallel to it
        const nx = H / Math.hypot(H, 0.44 * W), ny = (-0.44 * W) / Math.hypot(H, 0.44 * W);
        const span = W * 0.5 * nx + 200, s = ((now / 1000) % 9) / 6 * span - 120;
        if (s < span) {
          const g = ctx.createLinearGradient(nx * (s - 110), ny * (s - 110) + H * 0.5, nx * (s + 110), ny * (s + 110) + H * 0.5);
          g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(0.5, "rgba(255,255,255,0.4)"); g.addColorStop(1, "rgba(255,255,255,0)");
          ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        }
        // an ambient wash so there is always something lit, plus the cursor
        blob(W * 0.2 + Math.sin(now / 5200) * 90, H * 0.28 + Math.cos(now / 6100) * 50, 260, 0.3);
        if (cursor.s > 0.01) blob(cursor.x, cursor.y, 240, 0.95 * cursor.s);
        const f = form()?.getBoundingClientRect();
        if (f && focus.s > 0.01) {
          const r = wl.getBoundingClientRect();
          blob(f.left - r.left + f.width / 2, f.top - r.top + f.height / 2, 330, 0.75 * focus.s);
        }
        acc += dt * (1.1 + focus.s * 3);
        while (acc > 1 && pulses.length < 14) {
          acc -= 1;
          if (focus.s > 0.3 && f) {
            const r = wl.getBoundingClientRect();
            spawn(f.left - r.left + Math.random() * f.width, f.top - r.top - 20 - Math.random() * 120);
          } else spawn(30 + Math.random() * W * 0.3, 70 + Math.random() * H * 0.7);
        }
        acc = Math.min(acc, 1);
        for (let k = pulses.length - 1; k >= 0; k--) {
          const p = pulses[k];
          p.life += dt;
          const alive = step(p, 220 * dt);
          const x = p.ox + p.a[0] + (p.b[0] - p.a[0]) * p.t, y = p.oy + p.a[1] + (p.b[1] - p.a[1]) * p.t;
          if (!alive || x > W || p.life > 6) { pulses.splice(k, 1); continue; }
          blob(x, y, 84, Math.min(1, p.life * 2));
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
