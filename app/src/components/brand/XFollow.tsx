import { OUTBOUND } from "@/lib/landing/config";
import "./x-follow.css";

export const X_HANDLE = "@PlayTesoro";

/** a = icon chip in headers (landing, app); b = emerald-edged button (waitlist, landing closing call to action). */
export type XVariant = "a" | "b";

/** The X mark, monochrome. */
export function XMark({ size = 18 }: { size?: number }) {
  return (
    <svg className="xf-mark" viewBox="0 0 24 24" width={size} height={size} aria-hidden fill="currentColor">
      <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
    </svg>
  );
}

/** head = in a header (compact, always visible), cta = beside a call to action, foot = in a footer. */
export type XPlace = "head" | "cta" | "foot";

/** A link to Tesoro on X. `short` replaces the label on phones (e.g. "Follow" beside a big button). */
export function XFollow({ variant, place, short, className = "" }: { variant: XVariant; place: XPlace; short?: string; className?: string }) {
  if (!OUTBOUND.x) return null;
  const link = { href: OUTBOUND.x, target: "_blank", rel: "noopener", "aria-label": `Follow ${X_HANDLE} on X` } as const;
  const base = `xf xf-${variant} xf-${place} ${className}`;

  if (place === "foot") {
    return (
      <a {...link} className={`${base} xf-link`}>
        <XMark size={14} />
        <span>Follow {X_HANDLE}</span>
      </a>
    );
  }
  if (variant === "a" && place === "head") {
    return (
      <a {...link} className={`${base} cut icon-btn`}>
        <XMark />
      </a>
    );
  }
  const label = place === "head" ? "Follow" : `Follow ${X_HANDLE}`;
  return (
    <a {...link} className={`${base} btn neutral cut cut-btn${short ? " xf-has-short" : ""}`}>
      <XMark size={place === "head" ? 16 : 18} />
      <span className="xf-label xf-long">{label}</span>
      {short && <span className="xf-label xf-short">{short}</span>}
    </a>
  );
}
