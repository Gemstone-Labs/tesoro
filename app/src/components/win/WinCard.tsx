import { CARD, Fill, Lockup, OG_FONTS, Rays, Tagline, Texture, Window, fitSize, rgba, type CardFonts } from "@/components/waitlist/SpotCard";
import { GAME_NAMES } from "@/lib/mock";
import type { WinCardData } from "@/lib/win-card";

const BG = "#0C0E10";
const FG = "#F5F3EE";
const FG2 = "#A7ACB4";

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * The card for a won Match, 1200x630: the winner's Profile picture in its window, the Gemas won, the Game and the
 * entry. Same frame as the waitlist spot card, and written for `next/og` the same way (flex only, one text node per element).
 */
export function WinCard({ win, src, fonts = OG_FONTS }: { win: WinCardData; src: string; fonts?: CardFonts }) {
  const big = win.gemas > 0 ? `+${fmt(win.gemas)}` : "WON";
  return (
    <div style={{ display: "flex", width: CARD.width, height: CARD.height, fontFamily: fonts.sans, textAlign: "left", lineHeight: 1.2 }}>
      <div style={{ display: "flex", position: "relative", width: "100%", height: "100%", background: BG }}>
        <Texture />
        <Rays cx={284} cy={315} hex={win.hex} />
        <Fill style={{ backgroundImage: `linear-gradient(90deg, ${rgba(BG, 0)} 40%, ${rgba(BG, 0.85)} 62%)` }} />
        <div style={{ display: "flex", position: "relative", width: "100%", height: "100%", padding: 64, gap: 64, alignItems: "center" }}>
          <Window src={src} size={440} hex={win.hex} halo={0.5} />
          <div style={{ display: "flex", flexDirection: "column", width: 568, height: "100%", justifyContent: "space-between" }}>
            <Lockup height={52} />
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontFamily: fonts.sans, fontWeight: 700, fontSize: 24, color: FG2, letterSpacing: 4, textTransform: "uppercase" }}>
                {`${win.name} won`}
              </div>
              <div style={{ display: "flex", fontFamily: fonts.display, fontWeight: 800, fontSize: fitSize(big, 200, 568), lineHeight: 0.92, color: FG }}>{big}</div>
              <div style={{ display: "flex", fontFamily: fonts.display, fontWeight: 800, fontSize: 56, lineHeight: 1, color: win.hex, textTransform: "uppercase", marginTop: 10 }}>
                {win.gemas > 0 ? "Gemas" : "a Match"}
              </div>
              <div style={{ display: "flex", fontFamily: fonts.sans, fontWeight: 400, fontSize: 28, color: FG2, marginTop: 18 }}>
                {`${GAME_NAMES[win.game]} · entry ${fmt(win.entry)} Gemas`}
              </div>
            </div>
            <Tagline F={fonts} size={44} />
          </div>
        </div>
      </div>
    </div>
  );
}
