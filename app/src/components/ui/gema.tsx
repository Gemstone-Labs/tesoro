import { fmtGemas } from "@/lib/format";

/** Shared gradients for every GemaMark. Mount once in the root layout. */
export function GemaDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="gema-face" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8FF5CF" />
          <stop offset=".5" stopColor="#2DBE8C" />
          <stop offset="1" stopColor="#0B6B4E" />
        </linearGradient>
        <linearGradient id="gema-table" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#C9FFE9" />
          <stop offset="1" stopColor="#3FD69F" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/**
 * The Gema mark: an emerald-cut stone. `glint` runs the brief highlight
 * animation (balance only; disabled under prefers-reduced-motion).
 */
export function GemaMark({ size = 16, glint = false }: { size?: number; glint?: boolean }) {
  return (
    <svg
      className={`gema-mark${glint ? " glint" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <polygon points="7,3 17,3 22,8 22,16 17,21 7,21 2,16 2,8" fill="url(#gema-face)" />
      <polygon points="9,7 15,7 18,10 18,14 15,17 9,17 6,14 6,10" fill="url(#gema-table)" />
      <path
        d="M7 3 9 7M17 3 15 7M22 8 18 10M22 16 18 14M17 21 15 17M7 21 9 17M2 16 6 14M2 8 6 10"
        stroke="#063D2C"
        strokeOpacity=".45"
        strokeWidth=".7"
        fill="none"
      />
      <polygon className="shine" points="9,7 12,7 7.5,17 6,14" fill="#FFFFFF" />
    </svg>
  );
}

const MARK_PX = { sm: 14, md: 16, lg: 20, xl: 30 } as const;

export function GemaAmount({
  value,
  size = "md",
  glint = false,
  sign = false,
  mark = true,
}: {
  value: number;
  size?: keyof typeof MARK_PX;
  glint?: boolean;
  /** Show an explicit + or − (a second signal for gains and losses). */
  sign?: boolean;
  mark?: boolean;
}) {
  const prefix = sign ? (value > 0 ? "+" : value < 0 ? "−" : "") : "";
  return (
    <span className={`gema-amount ${size}`}>
      {mark && <GemaMark size={MARK_PX[size]} glint={glint} />}
      <span>
        {prefix}
        {fmtGemas(Math.abs(value))}
        <span className="sr-only"> Gemas</span>
      </span>
    </span>
  );
}

export function SimulatedYieldLabel({ align = "left", className }: { align?: "left" | "center" | "right"; className?: string }) {
  return (
    <span className={className ? `sim ${className}` : "sim"} style={{ textAlign: align, display: "block" }}>
      Simulated yield · 1 month = 10 min
    </span>
  );
}
