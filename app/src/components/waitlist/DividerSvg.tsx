import { dividerScene } from "./dividers/octa";
import type { Frame } from "./dividers/geo";

/**
 * The divider as an SVG: the ground and the gems filled with the page's own texture, as a pattern anchored at the frame's
 * origin so the texture runs on across them. Plain markup (no hooks), so the server can draw it too. `stretch` fits a
 * design-size layout to whatever frame it lands in (used for the first paint and without JavaScript).
 */
export function DividerSvg({ frame, id, className, stretch = false }: { frame: Frame; id: string; className: string; stretch?: boolean }) {
  const { ground, gems } = dividerScene(frame);
  return (
    <svg className={className} viewBox={`0 0 ${frame.w} ${frame.h}`} preserveAspectRatio={stretch ? "none" : undefined} aria-hidden focusable="false">
      <defs>
        <pattern id={id} width="360" height="300" patternUnits="userSpaceOnUse">
          <rect width="360" height="300" fill="#090d0f" />
          <g fill="none" stroke="#eaefec" strokeOpacity="0.045">
            <path d="M70 40h180l40 40v120l-40 40H70l-40-40V80z" />
            <path d="M98 68h124l28 28v88l-28 28H98l-28-28V96z" />
            <path d="M270 220l80 80M350 0l10 10M0 10l50 50M50 220L0 270M360 270l-30 30M330 0l-60 60" />
          </g>
        </pattern>
      </defs>
      <path d={ground} fill={`url(#${id})`} />
      <path d={gems} fill={`url(#${id})`} />
    </svg>
  );
}
