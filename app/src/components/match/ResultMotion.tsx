import type { CSSProperties } from "react";

type Css = CSSProperties & Record<`--${string}`, string | number>;

/** A figure whose digits roll into place like an odometer; separators and signs stay put. At rest (and under reduced motion) it is the plain figure. */
export function Odometer({ text, delay = 0, className }: { text: string; delay?: number; className?: string }) {
  const chars = [...text];
  const digits = chars.filter((c) => /\d/.test(c)).length;
  let i = 0;
  return (
    <span className={`odo${className ? ` ${className}` : ""}`} role="img" aria-label={text}>
      {chars.map((c, k) => {
        if (!/\d/.test(c)) return <span key={k} className={`odo-s${c === "," ? " sep" : ""}`} aria-hidden="true">{c}</span>;
        const d = Number(c);
        const order = i++;
        // two full turns, then up to the digit
        const rows = [...Array(20).keys()].map((n) => n % 10).concat([...Array(d + 1).keys()]);
        const style: Css = { "--to": 20 + d, "--dur": `${1100 + (digits - order) * 180}ms`, "--d": `${delay}ms` };
        return (
          <span key={k} className="odo-col" aria-hidden="true">
            <span className="odo-ghost">{c}</span>
            <span className="odo-strip" style={style}>
              {rows.map((n, r) => <span key={r}>{n}</span>)}
            </span>
          </span>
        );
      })}
    </span>
  );
}

/** Emerald octagon shards: a one-shot burst from the centre, or a short rain from the top. Decorative, motion only. */
export function Shards({ n = 22, kind = "burst", delay = 0 }: { n?: number; kind?: "burst" | "rain"; delay?: number }) {
  return (
    <span className={`shards ${kind}`} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => {
        const a = (i / n) * Math.PI * 2 + (i % 3) * 0.2;
        const r = 140 + ((i * 53) % 160);
        // offsets rounded so the server and client markup match
        const style: Css =
          kind === "burst"
            ? { "--x": `${(Math.cos(a) * r).toFixed(1)}px`, "--y": `${(Math.sin(a) * r * 0.7).toFixed(1)}px`, "--r": `${(i * 67) % 360}deg`, "--s": `${8 + ((i * 7) % 14)}px`, "--d": `${delay + (i % 5) * 40}ms` }
            : { "--x": `${(i * 37) % 100}%`, "--r": `${(i * 67) % 360}deg`, "--s": `${10 + ((i * 7) % 18)}px`, "--d": `${delay + ((i * 211) % 2400)}ms`, "--t": `${2200 + ((i * 97) % 1600)}ms` };
        return <i key={i} style={style} />;
      })}
    </span>
  );
}
