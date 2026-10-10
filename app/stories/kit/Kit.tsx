import { useState, type ReactNode } from "react";
import "./kit.css";

export function Kit({ children }: { children: ReactNode }) {
  return <div className="kit">{children}</div>;
}

export function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="stack">
      <h3>{title}</h3>
      {note && <p className="kit-note">{note}</p>}
      {children}
    </section>
  );
}

/** A short excerpt of DESIGN.md. */
export function Quote({ children }: { children: ReactNode }) {
  return <blockquote className="kit-quote">{children}</blockquote>;
}

export function Ground({ tone, children }: { tone: "dark" | "light"; children: ReactNode }) {
  return <div className={`kit-ground ${tone}`}>{children}</div>;
}

export function CopyPath({ path }: { path: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(path);
    } catch {
      const t = document.createElement("textarea");
      t.value = path;
      document.body.append(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  };
  return (
    <button type="button" className="kit-copy" data-done={done} onClick={copy} title={`Copy ${path}`}>
      {done ? "Copied" : "Copy path"}
    </button>
  );
}

const fileName = (path: string) => path.split("/").pop() ?? path;

/** One asset: preview, file name, natural pixel size (read on load) and click-to-copy path. */
export function Tile({ path, media = "img", ground = "dark", maxH, label, copy }: { path: string; media?: "img" | "video"; ground?: "dark" | "light" | "checker"; maxH?: number; label?: string; copy?: string }) {
  const [size, setSize] = useState("");
  const set = (w: number, h: number) => w && setSize(`${w} × ${h}`);
  return (
    <figure className="kit-tile" style={{ margin: 0 }}>
      <div className={`kit-tile-media ${ground === "dark" ? "" : ground}`} style={maxH ? ({ "--max-h": `${maxH}px` } as React.CSSProperties) : undefined}>
        {media === "img" ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={path} alt="" loading="lazy" decoding="async" onLoad={(e) => set(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />
        ) : (
          <video src={path} controls muted loop playsInline preload="metadata" onLoadedMetadata={(e) => set(e.currentTarget.videoWidth, e.currentTarget.videoHeight)} />
        )}
      </div>
      <figcaption className="stack" style={{ gap: 4 }}>
        <span className="kit-tile-name">{label ?? fileName(path)}</span>
        <span className="kit-tile-meta">{copy ?? path}</span>
        <span className="kit-tile-meta">{size || "…"} px</span>
        <CopyPath path={copy ?? path} />
      </figcaption>
    </figure>
  );
}
