import type { CSSProperties } from "react";
import { MARK, PALETTE, WORDMARK } from "@/components/brand/paths";
import type { SpotGem } from "@/lib/waitlist-spot";

/**
 * The X card for a waitlist spot, 1200x630. Written for `next/og` (flex only, no `inset`, no
 * multi-node text), so the same markup renders as the PNG and in Storybook.
 */
export const CARD = { width: 1200, height: 630 } as const;
export const CARD_VARIANTS = ["A", "B", "C"] as const;
export type CardVariant = (typeof CARD_VARIANTS)[number];

/** Font family names: the ones registered with `next/og`, or CSS stacks in the browser. */
export type CardFonts = { display: string; sans: string };
export const OG_FONTS: CardFonts = { display: "Display", sans: "Sans" };

type Props = { gem: SpotGem; src: string; F: CardFonts };

const BG = "#0C0E10";
const FG = "#F5F3EE";
const FG2 = "#A7ACB4";
const EMERALD = "#2DBE8C";
const rgba = (hex: string, a: number) =>
  `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`;
const OCTAGON = "polygon(27% 0, 73% 0, 100% 27%, 100% 73%, 73% 100%, 27% 100%, 0 73%, 0 27%)";

function Lockup({ height }: { height: number }) {
  const p = PALETTE.dark;
  const markW = height;
  const wordH = height * 0.46;
  const wordW = (WORDMARK.w / WORDMARK.h) * wordH;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: height * 0.28 }}>
      <svg width={markW} height={height} viewBox={`0 0 ${MARK.size} ${MARK.size}`}>
        <path fill={p.body} d={MARK.octagon} />
        <path fill={p.table} d={MARK.table} />
        <path fill={p.left} d={MARK.left} />
        <path fill={p.right} d={MARK.right} />
      </svg>
      <svg width={wordW} height={wordH} viewBox={`-10 0 ${WORDMARK.w + 20} ${WORDMARK.h + 10}`}>
        <path d={WORDMARK.d} fill="none" stroke={FG} strokeWidth={WORDMARK.stroke} strokeLinejoin="bevel" />
      </svg>
    </div>
  );
}

function Avatar({ src, size, hex }: { src: string; size: number; hex: string }) {
  return (
    <div style={{ display: "flex", position: "relative", width: size, height: size }}>
      <div
        style={{
          position: "absolute",
          left: -size * 0.18,
          top: -size * 0.18,
          width: size * 1.36,
          height: size * 1.36,
          display: "flex",
          backgroundImage: `radial-gradient(circle, ${rgba(hex, 0.35)} 0%, ${rgba(hex, 0)} 65%)`,
        }}
      />
      <div style={{ display: "flex", width: size, height: size, clipPath: OCTAGON, background: hex }}>
        <div style={{ display: "flex", margin: 4, width: size - 8, height: size - 8, clipPath: OCTAGON }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} width={size - 8} height={size - 8} alt="" />
        </div>
      </div>
    </div>
  );
}

/** A: the collectible. Gem on the left, spot number big on the right. */
function Collectible({ gem, src, F }: Props) {
  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: BG, padding: 64, gap: 64, alignItems: "center" }}>
      <Avatar src={src} size={440} hex={gem.hex} />
      <div style={{ display: "flex", flexDirection: "column", flex: 1, height: "100%", justifyContent: "space-between" }}>
        <Lockup height={52} />
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontFamily: F.sans, fontWeight: 700, fontSize: 26, color: FG2, letterSpacing: 3, textTransform: "uppercase" }}>
            Waitlist spot
          </div>
          <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 200, lineHeight: 0.9, color: FG }}>{`#${gem.spot}`}</div>
          <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 64, lineHeight: 1, color: gem.hex, textTransform: "uppercase", marginTop: 8 }}>
            {gem.name}
          </div>
        </div>
        <div style={{ display: "flex", fontFamily: F.display, fontWeight: 800, fontSize: 44, textTransform: "uppercase", gap: 14 }}>
          <span style={{ color: FG }}>Play now,</span>
          <span style={{ color: EMERALD }}>pay later.</span>
        </div>
      </div>
    </div>
  );
}

/** B: the ticket. A stub with the gem, a torn rule, the pass on the right. */
function Ticket({ gem, src, F }: Props) {
  const num = String(gem.spot).padStart(4, "0");
  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: "#060708", padding: 48 }}>
      <div style={{ display: "flex", flex: 1, background: BG, border: `2px solid ${rgba(gem.hex, 0.4)}` }}>
        <div style={{ display: "flex", width: 400, alignItems: "center", justifyContent: "center", background: rgba(gem.hex, 0.08) }}>
          <Avatar src={src} size={300} hex={gem.hex} />
        </div>
        <div style={{ display: "flex", width: 0, borderLeft: `3px dashed ${rgba(FG2, 0.4)}`, margin: "24px 0" }} />
        <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "40px 48px", justifyContent: "space-between" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Lockup height={42} />
            <div style={{ fontFamily: F.sans, fontWeight: 700, fontSize: 22, color: EMERALD, letterSpacing: 3, textTransform: "uppercase" }}>
              Early access
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontFamily: F.sans, fontWeight: 400, fontSize: 24, color: FG2 }}>Admit one</div>
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 170, lineHeight: 0.9, color: FG, letterSpacing: 4 }}>{`No. ${num}`}</div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
            <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 52, color: gem.hex, textTransform: "uppercase" }}>{gem.name}</div>
            <div style={{ fontFamily: F.sans, fontWeight: 400, fontSize: 22, color: FG2 }}>Play now, pay later.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** C: the poster. The gem fills the right half; headline in the X banner's voice. */
function Poster({ gem, src, F }: Props) {
  return (
    <div style={{ display: "flex", width: "100%", height: "100%", background: BG, position: "relative" }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} width={630} height={630} alt="" style={{ position: "absolute", right: 0, top: 0 }} />
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: "100%",
          height: "100%",
          display: "flex",
          backgroundImage: `linear-gradient(90deg, ${rgba(BG, 1)} 48%, ${rgba(BG, 0)} 62%)`,
        }}
      />
      <div style={{ display: "flex", flexDirection: "column", padding: 64, justifyContent: "space-between", height: "100%", width: 720, position: "relative" }}>
        <Lockup height={52} />
        <div style={{ display: "flex", flexDirection: "column", fontFamily: F.display, fontWeight: 800, fontSize: 120, lineHeight: 0.92, textTransform: "uppercase" }}>
          <span style={{ color: FG }}>Play now,</span>
          <span style={{ color: EMERALD }}>pay later.</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div
            style={{
              display: "flex",
              fontFamily: F.display, fontWeight: 800,
              fontSize: 40,
              color: BG,
              background: gem.hex,
              padding: "2px 14px",
            }}
          >
            {`#${gem.spot}`}
          </div>
          <div style={{ fontFamily: F.display, fontWeight: 800, fontSize: 40, color: FG, textTransform: "uppercase" }}>{gem.name}</div>
        </div>
      </div>
    </div>
  );
}

const VARIANTS = { A: Collectible, B: Ticket, C: Poster } as const;

export function SpotCard({ gem, src, variant = "A", fonts = OG_FONTS }: { gem: SpotGem; src: string; variant?: CardVariant; fonts?: CardFonts }) {
  const Card = VARIANTS[variant];
  const box: CSSProperties = { display: "flex", width: CARD.width, height: CARD.height, overflow: "hidden" };
  return (
    <div style={box}>
      <Card gem={gem} src={src} F={fonts} />
    </div>
  );
}

