import type { CSSProperties } from "react";
import { layoutBlocks, type Block } from "./layout";

/**
 * One jewel: an octagon cut with a table facet and eight bevels lit from above, drawn once and reused. Colour
 * comes from `--k` on the <use>, the shades are mixed in waitlist.css.
 */
function Defs() {
  return (
    <svg className="gd-defs" aria-hidden focusable="false">
      <defs>
        <symbol id="gd-gem" viewBox="0 0 100 100">
          <polygon className="gd-f0" points="30,0 70,0 64,20 36,20" />
          <polygon className="gd-f1" points="70,0 100,30 80,36 64,20" />
          <polygon className="gd-f2" points="100,30 100,70 80,64 80,36" />
          <polygon className="gd-f3" points="100,70 70,100 64,80 80,64" />
          <polygon className="gd-f4" points="70,100 30,100 36,80 64,80" />
          <polygon className="gd-f5" points="30,100 0,70 20,64 36,80" />
          <polygon className="gd-f6" points="0,70 0,30 20,36 20,64" />
          <polygon className="gd-f7" points="0,30 30,0 36,20 20,36" />
          <polygon className="gd-table" points="36,20 64,20 80,36 80,64 64,80 36,80 20,64 20,36" />
          <polygon className="gd-glint" points="36,20 64,20 20,64 20,36" />
        </symbol>
      </defs>
    </svg>
  );
}

function Band({ variant }: { variant: "wide" | "tall" }) {
  const blocks = layoutBlocks(variant);
  return (
    <div className={`gd gd-${variant}`} aria-hidden>
      {blocks.map((b: Block) => (
        <svg
          key={b.i}
          className="gd-b"
          data-hue={b.hue}
          viewBox="0 0 100 100"
          style={{ left: `${b.x.toFixed(2)}%`, top: `${b.y.toFixed(2)}%`, width: `${b.size.toFixed(2)}%`, "--i": b.i, "--t": b.t.toFixed(3) } as CSSProperties}
        >
          <use href="#gd-gem" />
        </svg>
      ))}
    </div>
  );
}

/** The band of jewel blocks along the diagonal; the tall variant is the phone's, chosen by CSS. */
export function GemDivider() {
  return (
    <>
      <Defs />
      <Band variant="wide" />
      <Band variant="tall" />
    </>
  );
}
