import { DividerLive } from "./DividerLive";
import { DividerSvg } from "./DividerSvg";

/**
 * The edge between the panel and the footage. The server draws it for a 1440x900 and a 390x844 frame (CSS shows the one
 * that fits the screen), so the first paint and a page without JavaScript have the pattern; once hydrated, the exact
 * layout fades in over it.
 */
export function Divider() {
  return (
    <>
      <DividerSvg frame={{ w: 1440, h: 900, kind: "wide" }} id="dv-wide" className="dv dv-ssr dv-ssr-wide" stretch />
      <DividerSvg frame={{ w: 390, h: 844, kind: "tall" }} id="dv-tall" className="dv dv-ssr dv-ssr-tall" stretch />
      <DividerLive />
    </>
  );
}
