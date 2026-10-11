"use client";

import { readMuted, writeMuted } from "./sfx-pref";

export type Cue = "deal" | "flip" | "chip" | "check" | "fold" | "clear" | "combo" | "gem" | "tick" | "fill" | "win" | "lose" | "go";
export const CUES: Cue[] = ["deal", "flip", "chip", "check", "fold", "clear", "combo", "gem", "tick", "fill", "win", "lose", "go"];

let muted: boolean | null = null;
const listeners = new Set<() => void>();

/** Whether sound is off. Remembered per browser; sound is on by default. */
export function isMuted(): boolean {
  if (muted === null) muted = readMuted();
  return muted;
}

/** Turn sound off or on, remember it, and tell every MuteToggle. */
export function setMuted(next: boolean): void {
  muted = next;
  writeMuted(next);
  listeners.forEach((l) => l());
}

export function subscribeMuted(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let armed = false;

function create() {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.16;
  // a short soft echo so cues sound like a room, not a beep
  const delay = ctx.createDelay(0.5);
  delay.delayTime.value = 0.09;
  const fb = ctx.createGain();
  fb.gain.value = 0.22;
  const wet = ctx.createGain();
  wet.gain.value = 0.3;
  master.connect(ctx.destination);
  master.connect(delay);
  delay.connect(fb).connect(delay);
  delay.connect(wet).connect(ctx.destination);
}

/**
 * Browsers block audio until the Player touches the page: create the AudioContext on the first
 * gesture only. Called by `sfx` and `MuteToggle`; safe to call again.
 */
export function armSound(): void {
  if (armed || typeof window === "undefined") return;
  armed = true;
  const unlock = () => {
    window.removeEventListener("pointerdown", unlock, true);
    window.removeEventListener("keydown", unlock, true);
    if (!ctx) create();
    void ctx?.resume();
  };
  window.addEventListener("pointerdown", unlock, true);
  window.addEventListener("keydown", unlock, true);
}

function tone(freq: number, at: number, dur: number, o: { type?: OscillatorType; gain?: number; to?: number; attack?: number } = {}) {
  if (!ctx || !master) return;
  const t = ctx.currentTime + at;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(freq, t);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + dur);
  const peak = o.gain ?? 0.5;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + (o.attack ?? 0.008));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

function noise(at: number, dur: number, o: { from: number; to: number; gain?: number; q?: number }) {
  if (!ctx || !master) return;
  const t = ctx.currentTime + at;
  const len = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.Q.value = o.q ?? 1.2;
  f.frequency.setValueAtTime(o.from, t);
  f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(o.gain ?? 0.4, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

// C major pentatonic, so any run of clears sounds pleasant
const N = { c5: 523.25, d5: 587.33, e5: 659.25, g5: 783.99, a5: 880, c6: 1046.5, e6: 1318.5, g6: 1568 };

const PLAY: Record<Cue, () => void> = {
  deal: () => {
    noise(0, 0.09, { from: 2400, to: 900, gain: 0.5 });
    tone(220, 0.02, 0.05, { type: "triangle", gain: 0.25 });
  },
  flip: () => noise(0, 0.12, { from: 700, to: 3200, gain: 0.45, q: 2 }),
  chip: () => {
    tone(2400, 0, 0.06, { type: "triangle", gain: 0.35 });
    tone(3300, 0.045, 0.07, { type: "triangle", gain: 0.3 });
    tone(1800, 0.09, 0.08, { type: "triangle", gain: 0.2 });
  },
  check: () => {
    tone(190, 0, 0.09, { gain: 0.6, to: 140 });
    tone(190, 0.12, 0.09, { gain: 0.5, to: 140 });
  },
  fold: () => noise(0, 0.22, { from: 1800, to: 300, gain: 0.35, q: 0.8 }),
  clear: () => {
    [N.c5, N.e5, N.g5].forEach((f, i) => tone(f, i * 0.055, 0.28, { type: "triangle", gain: 0.34 }));
    tone(N.c6, 0.17, 0.4, { gain: 0.22 });
  },
  combo: () => {
    [N.c5, N.d5, N.e5, N.g5, N.a5, N.c6].forEach((f, i) => tone(f, i * 0.05, 0.3, { type: "triangle", gain: 0.3 }));
    tone(N.e6, 0.3, 0.5, { gain: 0.2 });
  },
  gem: () => {
    tone(N.e6, 0, 0.7, { gain: 0.38 });
    tone(N.e6 * 1.5, 0, 0.5, { gain: 0.18 });
    tone(N.g6, 0.08, 0.6, { gain: 0.2 });
  },
  tick: () => tone(1100, 0, 0.04, { type: "triangle", gain: 0.3 }),
  fill: () => {
    tone(150, 0, 0.12, { gain: 0.6, to: 80 });
    tone(N.g5, 0.05, 0.18, { type: "triangle", gain: 0.28 });
    tone(N.c6, 0.11, 0.26, { type: "triangle", gain: 0.24 });
  },
  win: () => {
    [N.c5, N.e5, N.g5, N.c6].forEach((f, i) => tone(f, i * 0.09, 0.45, { type: "triangle", gain: 0.34 }));
    tone(N.e6, 0.4, 0.8, { gain: 0.25 });
    tone(N.g6, 0.4, 0.8, { gain: 0.15 });
  },
  lose: () => {
    tone(392, 0, 0.35, { type: "triangle", gain: 0.3, to: 370 });
    tone(311, 0.16, 0.5, { type: "triangle", gain: 0.3, to: 277 });
  },
  go: () => {
    tone(N.g5, 0, 0.14, { type: "triangle", gain: 0.34 });
    tone(N.c6, 0.1, 0.4, { type: "triangle", gain: 0.38 });
    tone(N.e6, 0.1, 0.4, { gain: 0.18 });
  },
};

/** Play a short synthesized cue. Silent when muted, before the first gesture, or without WebAudio. */
export function sfx(cue: Cue): void {
  if (typeof window === "undefined") return;
  armSound();
  if (isMuted() || !ctx || ctx.state !== "running") return;
  try {
    PLAY[cue]();
  } catch {
    // audio is optional
  }
}
