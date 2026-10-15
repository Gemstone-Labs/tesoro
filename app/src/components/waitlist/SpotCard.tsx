import type { CSSProperties, ReactNode } from "react";
import { MARK, PALETTE, WORDMARK } from "@/components/brand/paths";
import type { SpotGem } from "@/lib/waitlist-spot";

/**
 * The card for a waitlist spot (founder pick A1), 1200x630: the X card and the card inside the pack. Written for
 * `next/og` (flex only, no `inset`, one text node per element), so the same markup renders as the
 * PNG and in the browser.
 */
export const CARD = { width: 1200, height: 630 } as const;

/** Font family names: the ones registered with `next/og`, or CSS stacks in the browser. */
export type CardFonts = { display: string; sans: string };
export const OG_FONTS: CardFonts = { display: "Display", sans: "Sans" };

const BG = "#0C0E10";
const FG = "#F5F3EE";
const FG2 = "#A7ACB4";
const EMERALD = "#2DBE8C";

export const rgba = (hex: string, a: number) =>
  `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${a})`;

/** The largest size (px) at which `text` in the condensed display face fits `width`. */
export function fitSize(text: string, max: number, width: number, em = 0.56): number {
  return Math.min(max, Math.floor(width / (text.length * em)));
}

type Props = { gem: SpotGem; src: string; F: CardFonts };

export function Lockup({ height }: { height: number }) {
  const p = PALETTE.dark;
  const wordH = height * 0.46;
  const wordW = (WORDMARK.w / WORDMARK.h) * wordH;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: height * 0.28 }}>
      <svg width={height} height={height} viewBox={`0 0 ${MARK.size} ${MARK.size}`}>
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

const octagon = (x: number, y: number, w: number, h: number, c: number) =>
  `M${x + c} ${y}H${x + w - c}L${x + w} ${y + c}V${y + h - c}L${x + w - c} ${y + h}H${x + c}L${x} ${y + h - c}V${y + c}Z`;

/**
 * The gem in an octagon window, its colour as the frame and a halo behind. The art is a clipped
 * background image with no background colour: next/og does not clip a colour.
 */
export function Window({ src, size, hex, halo = 0.35 }: { src: string; size: number; hex: string; halo?: number }) {
  const c = size * 0.27;
  return (
    <div
      style={{
        display: "flex",
        position: "relative",
        width: size,
        height: size,
      }}
    >
      <div
        style={{
          position: "absolute",
          left: -size * 0.2,
          top: -size * 0.2,
          width: size * 1.4,
          height: size * 1.4,
          display: "flex",
          backgroundImage: `radial-gradient(circle, ${rgba(hex, halo)} 0%, ${rgba(hex, 0)} 66%)`,
        }}
      />
      <div
        style={{
          display: "flex",
          width: size,
          height: size,
          clipPath: `polygon(${c}px 0, ${size - c}px 0, ${size}px ${c}px, ${size}px ${size - c}px, ${size - c}px ${size}px, ${c}px ${size}px, 0 ${size - c}px, 0 ${c}px)`,
          backgroundImage: `url(${src})`,
          backgroundSize: `${size}px ${size}px`,
        }}
      />
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: "absolute", left: 0, top: 0 }}>
        <path d={octagon(2, 2, size - 4, size - 4, c - 1)} fill="none" stroke={hex} strokeWidth="4" />
      </svg>
    </div>
  );
}

/** Light rays in the gem's colour, centred on (cx, cy). */
export function Rays({
  cx,
  cy,
  hex,
  r = 760,
  n = 18,
  w = CARD.width,
  h = CARD.height,
}: {
  cx: number;
  cy: number;
  hex: string;
  r?: number;
  n?: number;
  w?: number;
  h?: number;
}) {
  const id = `ray-${hex.slice(1)}-${cx}-${cy}`;
  const wedges = Array.from({ length: n }, (_, i) => {
    const a0 = (i / n) * Math.PI * 2;
    const a1 = a0 + (Math.PI * 2) / n / 2.6;
    const p = (a: number) => `${(cx + Math.cos(a) * r).toFixed(1)},${(cy + Math.sin(a) * r).toFixed(1)}`;
    return `M${cx},${cy} L${p(a0)} L${p(a1)} Z`;
  }).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: "absolute", left: 0, top: 0 }}>
      <defs>
        <radialGradient id={id} cx={cx} cy={cy} r={r} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={hex} stopOpacity="0.34" />
          <stop offset="0.55" stopColor={hex} stopOpacity="0.08" />
          <stop offset="1" stopColor={hex} stopOpacity="0" />
        </radialGradient>
      </defs>
      <path d={wedges} fill={`url(#${id})`} />
    </svg>
  );
}

/** The waitlist's octagon texture, faint, over the whole card. */
export function Texture({ w = CARD.width, h = CARD.height }: { w?: number; h?: number }) {
  const tile = (x: number, y: number) =>
    `M${x + 70} ${y + 40}h180l40 40v120l-40 40H${x + 70}l-40-40V${y + 80}z M${x + 270} ${y + 220}l80 80M${x + 350} ${y}l10 10`;
  const d = [0, 360, 720, 1080].flatMap((x) => [0, 300, 600].map((y) => tile(x, y))).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: "absolute", left: 0, top: 0 }}>
      <path d={d} fill="none" stroke="#EAEFEC" strokeOpacity="0.05" strokeWidth="2" />
    </svg>
  );
}

export function Fill({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        display: "flex",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Tagline({ F, size }: { F: CardFonts; size: number }) {
  return (
    <div
      style={{
        display: "flex",
        fontFamily: F.display,
        fontWeight: 800,
        fontSize: size,
        textTransform: "uppercase",
        gap: size * 0.3,
      }}
    >
      <span style={{ color: FG }}>Play now,</span>
      <span style={{ color: EMERALD }}>pay later.</span>
    </div>
  );
}

/** Spot number and name, each sized to fit the column. */
function Title({ gem, F, width, max = 200 }: { gem: SpotGem; F: CardFonts; width: number; max?: number }) {
  const num = `#${gem.spot}`;
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div
        style={{
          fontFamily: F.sans,
          fontWeight: 700,
          fontSize: 24,
          color: FG2,
          letterSpacing: 4,
          textTransform: "uppercase",
        }}
      >
        Waitlist spot
      </div>
      <div
        style={{
          fontFamily: F.display,
          fontWeight: 800,
          fontSize: fitSize(num, max, width),
          lineHeight: 0.92,
          color: FG,
        }}
      >
        {num}
      </div>
      <div
        style={{
          fontFamily: F.display,
          fontWeight: 800,
          fontSize: fitSize(gem.name, 64, width, 0.47),
          lineHeight: 1,
          color: gem.hex,
          textTransform: "uppercase",
          marginTop: 10,
        }}
      >
        {gem.name}
      </div>
    </div>
  );
}

/** The gem in its window over its own light rays and the waitlist texture; spot, name and tagline beside it. */
function Lit({ gem, src, F }: Props) {
  return (
    <div
      style={{
        display: "flex",
        position: "relative",
        width: "100%",
        height: "100%",
        background: BG,
      }}
    >
      <Texture />
      <Rays cx={284} cy={315} hex={gem.hex} />
      <Fill
        style={{
          backgroundImage: `linear-gradient(90deg, ${rgba(BG, 0)} 40%, ${rgba(BG, 0.85)} 62%)`,
        }}
      />
      <div
        style={{
          display: "flex",
          position: "relative",
          width: "100%",
          height: "100%",
          padding: 64,
          gap: 64,
          alignItems: "center",
        }}
      >
        <Window src={src} size={440} hex={gem.hex} halo={0.5} />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            width: 568,
            height: "100%",
            justifyContent: "space-between",
          }}
        >
          <Lockup height={52} />
          <Title gem={gem} F={F} width={568} />
          <Tagline F={F} size={44} />
        </div>
      </div>
    </div>
  );
}

export function SpotCard({ gem, src, fonts = OG_FONTS }: { gem: SpotGem; src: string; fonts?: CardFonts }) {
  return (
    <div style={{ display: "flex", width: CARD.width, height: CARD.height, fontFamily: fonts.sans, textAlign: "left", lineHeight: 1.2 }}>
      <Lit gem={gem} src={src} F={fonts} />
    </div>
  );
}
