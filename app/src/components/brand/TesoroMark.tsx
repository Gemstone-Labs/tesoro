import { LOCKUP, MARK, PALETTE, WORDMARK } from "./paths";

/**
 * The Tesoro Facet T: product brand only. The plain faceted gem (`GemaMark`) is the Gema currency
 * and must never stand in for this, nor the other way round.
 * `full` is the four-facet mark (holds down to 16px), `mono` is the T alone in currentColor.
 */
export type MarkVariant = "full" | "mono";
type Tone = "dark" | "light";

function MarkBody({ variant, tone }: { variant: MarkVariant; tone: Tone }) {
  if (variant === "mono") return <path fill="currentColor" d={MARK.mono} />;
  const p = PALETTE[tone];
  return (
    <>
      <path fill={p.body} d={MARK.octagon} />
      <path fill={p.table} d={MARK.table} />
      <path fill={p.left} d={MARK.left} />
      <path fill={p.right} d={MARK.right} />
    </>
  );
}

function Wordmark() {
  return (
    <path
      d={WORDMARK.d}
      fill="none"
      stroke="currentColor"
      strokeWidth={WORDMARK.stroke}
      strokeLinejoin="bevel"
      strokeLinecap="butt"
    />
  );
}

export function TesoroMark({
  variant = "full",
  size = 32,
  tone = "dark",
  title,
  className,
}: {
  variant?: MarkVariant;
  size?: number;
  /** Which background the mark sits on: `dark` (default) or `light` (deeper emerald). */
  tone?: Tone;
  title?: string;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${MARK.size} ${MARK.size}`}
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <MarkBody variant={variant} tone={tone} />
    </svg>
  );
}

/** Horizontal lockup: mark plus the chamfered-caps wordmark (currentColor). `height` is the mark height in px. */
export function TesoroLogo({ height = 34, tone = "dark", className }: { height?: number; tone?: Tone; className?: string }) {
  const scale = LOCKUP.capH / WORDMARK.h;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${LOCKUP.w} ${LOCKUP.h}`}
      width={(height * LOCKUP.w) / LOCKUP.h}
      height={height}
      className={className}
      role="img"
      aria-label="Tesoro"
    >
      <MarkBody variant="full" tone={tone} />
      <g transform={`translate(${MARK.size + LOCKUP.gap} ${(LOCKUP.h - LOCKUP.capH) / 2}) scale(${scale})`}>
        <Wordmark />
      </g>
    </svg>
  );
}
