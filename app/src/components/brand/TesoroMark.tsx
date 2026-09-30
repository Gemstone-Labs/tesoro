import { useId } from "react";
import { LOCKUP, MARK, PALETTE, WORDMARK } from "./paths";

/**
 * The Tesoro T-gem: product brand only. The plain faceted gem (`GemaMark`) is the Gema currency
 * and must never stand in for this, nor the other way round.
 * `full` is the faceted mark, `mono` is currentColor, `simple` (octagon + bold T) is for 32px and below.
 */
export type MarkVariant = "full" | "mono" | "simple";

const SIMPLE_T = "#06231B";

function Grad({ id, stops }: { id: string; stops: readonly [string, string] }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor={stops[0]} />
      <stop offset="1" stopColor={stops[1]} />
    </linearGradient>
  );
}

function MarkBody({ variant, uid, tone }: { variant: MarkVariant; uid: string; tone: "dark" | "light" }) {
  const p = PALETTE[tone];
  if (variant === "mono")
    return (
      <>
        <path fill="currentColor" fillOpacity=".45" d={MARK.dark} />
        <path fill="currentColor" fillOpacity=".75" d={MARK.mid} />
        <path fill="currentColor" d={MARK.light} />
      </>
    );
  if (variant === "simple")
    return (
      <>
        <defs>
          <Grad id={`${uid}m`} stops={p.mid} />
        </defs>
        <path fill={`url(#${uid}m)`} d={MARK.octagon} />
        <path fill={SIMPLE_T} d={MARK.t} />
      </>
    );
  return (
    <>
      <defs>
        <Grad id={`${uid}l`} stops={p.light} />
        <Grad id={`${uid}m`} stops={p.mid} />
        <Grad id={`${uid}d`} stops={p.dark} />
      </defs>
      <path fill={`url(#${uid}d)`} d={MARK.dark} />
      <path fill={`url(#${uid}m)`} d={MARK.mid} />
      <path fill={`url(#${uid}l)`} d={MARK.light} />
    </>
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
  tone?: "dark" | "light";
  title?: string;
  className?: string;
}) {
  const uid = useId().replace(/:/g, "");
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${MARK.w} ${MARK.h}`}
      width={size}
      height={(size * MARK.h) / MARK.w}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <MarkBody variant={variant} uid={uid} tone={tone} />
    </svg>
  );
}

/** Horizontal lockup: mark plus outlined wordmark (currentColor). `height` is the mark height in px. */
export function TesoroLogo({ height = 34, tone = "dark", className }: { height?: number; tone?: "dark" | "light"; className?: string }) {
  const uid = useId().replace(/:/g, "");
  const capTop = (LOCKUP.h - WORDMARK.capH) / 2;
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
      <MarkBody variant="full" uid={uid} tone={tone} />
      <g transform={`translate(${MARK.w + LOCKUP.gap} ${capTop})`}>
        <path fill="currentColor" d={WORDMARK.path} />
      </g>
    </svg>
  );
}
