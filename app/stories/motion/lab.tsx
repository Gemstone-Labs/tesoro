"use client";

import { useId, useState, type CSSProperties, type ReactNode } from "react";
import "./motion.css";

export const EASINGS: [string, string][] = [
  ["linear", "linear"],
  ["ease", "ease"],
  ["ease-in", "ease-in"],
  ["ease-out", "ease-out"],
  ["ease-in-out", "ease-in-out"],
  ["smooth (0.2, 0.8, 0.2, 1)", "cubic-bezier(0.2, 0.8, 0.2, 1)"],
  ["overshoot (0.2, 1.4, 0.4, 1)", "cubic-bezier(0.2, 1.4, 0.4, 1)"],
];

export interface Spec {
  /** The @keyframes name. */
  name: string;
  file: string;
  line: number;
  /** Where the app uses it, in plain words. */
  note: string;
  /** Defaults, as the CSS has them. */
  dur: number;
  ease: string;
  delay?: number;
  iter: number | "infinite";
  fill?: "none" | "forwards" | "backwards" | "both";
  /** Driven by scrolling the box, so there is nothing to time. */
  scroll?: boolean;
  /** A selector inside the stage (pseudo-elements too) when the animation is not on the stage's own element. */
  target?: string;
  /** Leave the CSS's own per-item delays alone (staggers). */
  keepDelay?: boolean;
  /** Light stage for light-theme looks. */
  stage: (style: CSSProperties) => ReactNode;
}

/** The delay of `style` plus `extra` ms: for staggered children. */
export function stagger(style: CSSProperties, extra: number): CSSProperties {
  return { ...style, animationDelay: `${(parseFloat(String(style.animationDelay ?? 0)) || 0) + extra}ms` };
}

function Card({ spec, all }: { spec: Spec; all: number }) {
  const uid = useId().replace(/[^a-z0-9]/gi, "");
  const [dur, setDur] = useState(spec.dur);
  const [ease, setEase] = useState(spec.ease);
  const [delay, setDelay] = useState(spec.delay ?? 0);
  const [iter, setIter] = useState(String(spec.iter));
  const [n, setN] = useState(0);
  const reset = () => {
    setDur(spec.dur);
    setEase(spec.ease);
    setDelay(spec.delay ?? 0);
    setIter(String(spec.iter));
    setN((v) => v + 1);
  };
  const props = {
    animationName: spec.name,
    animationDuration: `${dur}ms`,
    animationTimingFunction: ease,
    ...(spec.keepDelay ? {} : { animationDelay: `${delay}ms` }),
    animationIterationCount: iter,
    ...(spec.fill ? { animationFillMode: spec.fill } : {}),
  } satisfies CSSProperties;
  const css = spec.target
    ? `.sbm-${uid} ${spec.target} { ${Object.entries(props)
        .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${v} !important;`)
        .join(" ")} }`
    : null;
  const eases = EASINGS.some(([, v]) => v === spec.ease) ? EASINGS : ([[`default (${spec.ease})`, spec.ease], ...EASINGS] as [string, string][]);
  return (
    <article className="cut cut-card sbm-card" data-keyframe={spec.name}>
      <div>
        <h3>@keyframes {spec.name}</h3>
        <p className="where">
          {spec.file}:{spec.line}
        </p>
      </div>
      <p className="note">{spec.note}</p>
      <div className={`sbm-stage sbm-${uid}${spec.scroll ? " scroll" : ""}`} key={`${n}-${all}`}>
        {css && <style>{css}</style>}
        {spec.stage(spec.target || spec.scroll ? {} : props)}
      </div>
      {!spec.scroll && (
        <div className="sbm-ctl">
          <label>
            Duration ms
            <input type="number" min={0} step={50} value={dur} onChange={(e) => setDur(Math.max(0, Number(e.target.value)))} />
          </label>
          <label>
            Easing
            <select value={ease} onChange={(e) => setEase(e.target.value)}>
              {eases.map(([l, v]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            Delay ms
            <input type="number" min={-10000} step={50} value={delay} disabled={spec.keepDelay} onChange={(e) => setDelay(Number(e.target.value))} />
          </label>
          <label>
            Repeat
            <select value={iter} onChange={(e) => setIter(e.target.value)}>
              {["1", "2", "3", "infinite"].map((v) => (
                <option key={v}>{v}</option>
              ))}
              {!["1", "2", "3", "infinite"].includes(iter) && <option>{iter}</option>}
            </select>
          </label>
        </div>
      )}
      <div className="sbm-btns">
        <button type="button" className="sbm-btn primary" onClick={() => setN((v) => v + 1)}>
          Replay
        </button>
        {!spec.scroll && (
          <button type="button" className="sbm-btn" onClick={reset}>
            Reset
          </button>
        )}
      </div>
    </article>
  );
}

/** One card per keyframe, each with timing controls and a Replay. */
export function Lab({ specs, intro }: { specs: Spec[]; intro: string }) {
  const [all, setAll] = useState(0);
  return (
    <div className="sbm">
      <div className="sbm-intro">
        <p>{intro}</p>
        <button type="button" className="sbm-btn primary" onClick={() => setAll((v) => v + 1)}>
          Replay all
        </button>
      </div>
      <div className="sbm-grid">
        {specs.map((s) => (
          <Card key={s.name} spec={s} all={all} />
        ))}
      </div>
    </div>
  );
}

export function Sample({ children = "Tesoro", style, gem, className = "" }: { children?: ReactNode; style?: CSSProperties; gem?: boolean; className?: string }) {
  return (
    <div className={`cut cut-card sbm-sample${gem ? " gem" : ""} ${className}`} style={style}>
      {children}
    </div>
  );
}

/** A box that scrolls, for animations driven by the scroll position. */
export function ScrollBox({ children, rows = 8 }: { children?: ReactNode; rows?: number }) {
  return (
    <div style={{ height: "100%", overflow: "auto", display: "flex", flexDirection: "column" }}>
      {children}
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="sbm-scroll-item">
          Row {i + 1}
        </div>
      ))}
    </div>
  );
}

export interface Timing {
  dur: number;
  ease: string;
  delay: number;
}

/** Duration, easing and delay controls for a real, whole-screen animation; `rule` turns them into CSS for `selector`. */
export function useTiming(init: { dur: number; ease: string; delay?: number }, label = "") {
  const [t, setT] = useState<Timing>({ delay: 0, ...init });
  const eases = EASINGS.some(([, v]) => v === init.ease) ? EASINGS : ([[`default (${init.ease})`, init.ease], ...EASINGS] as [string, string][]);
  const panel = (
    <div className="sbm-row" aria-label={`${label} timing`}>
      <label>
        Duration ms
        <input type="number" min={0} step={50} value={t.dur} onChange={(e) => setT({ ...t, dur: Math.max(0, Number(e.target.value)) })} />
      </label>
      <label>
        Easing
        <select value={t.ease} onChange={(e) => setT({ ...t, ease: e.target.value })}>
          {eases.map(([l, v]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label>
        Delay ms
        <input type="number" min={0} step={50} value={t.delay} onChange={(e) => setT({ ...t, delay: Math.max(0, Number(e.target.value)) })} />
      </label>
      <button type="button" className="sbm-btn" onClick={() => setT({ delay: 0, ...init })}>
        Reset
      </button>
    </div>
  );
  const rule = (selector: string) =>
    `${selector} { animation-duration: ${t.dur}ms !important; animation-timing-function: ${t.ease} !important; animation-delay: ${t.delay}ms !important; }`;
  return { t, panel, rule };
}
