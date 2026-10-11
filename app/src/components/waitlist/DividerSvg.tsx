import { dividerScene, type Tuning } from "./dividers/octa";
import type { Frame } from "./dividers/geo";

/**
 * The divider as an SVG: the ground and the gems filled with the page's own texture, as a pattern anchored at the frame's
 * origin so the texture runs on across them. Plain markup (no hooks), so the server can draw it too. `stretch` fits a
 * design-size layout to whatever frame it lands in (used for the first paint and without JavaScript).
 */
export function DividerSvg({ frame, id, className, stretch = false, tuning = 1 }: { frame: Frame; id: string; className: string; stretch?: boolean; tuning?: Tuning }) {
  const { ground, gems } = dividerScene(frame, tuning);
  return (
    <svg className={className} viewBox={`0 0 ${frame.w} ${frame.h}`} preserveAspectRatio={stretch ? "none" : undefined} aria-hidden focusable="false">
      <defs>
        <pattern id={id} width="360" height="360" patternUnits="userSpaceOnUse">
          <rect width="360" height="360" fill="#090d0f" />
          <g fill="none" stroke="#eaefec" strokeOpacity="0.045">
            <path d="M70 40h180l40 40v120l-40 40H70l-40-40V80z" />
            <path d="M98 68h124l28 28v88l-28 28H98l-28-28V96z" />
            <path d="M250 40l60-40M290 200l70 40M70 240l-70 60M30 80L0 60" />
          </g>
        </pattern>
      </defs>
      <path d={ground} fill={`url(#${id})`} />
      <path d={gems} fill={`url(#${id})`} />
    </svg>
  );
}
