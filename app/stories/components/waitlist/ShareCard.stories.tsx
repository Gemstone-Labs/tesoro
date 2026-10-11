import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { TesoroMark } from "@/components/brand";
import { CARD, CARD_VARIANTS, SpotCard, type CardFonts, type CardVariant } from "@/components/waitlist/SpotCard";
import { GEMS, gemFor, shareText, spotPath } from "@/lib/waitlist-spot";

/** The PNG uses the same TTFs through next/og; here the page's own font stacks stand in. */
const FONTS: CardFonts = { display: "var(--f-display)", sans: "var(--f-body)" };
const SITE = "tesoro-fawn.vercel.app";

function Scaled({ width, children }: { width: number; children: React.ReactNode }) {
  const k = width / CARD.width;
  return (
    <div style={{ width, height: CARD.height * k, overflow: "hidden" }}>
      <div style={{ transform: `scale(${k})`, transformOrigin: "0 0" }}>{children}</div>
    </div>
  );
}

function Card({ spot, variant, width = CARD.width }: { spot: number; variant: CardVariant; width?: number }) {
  const gem = gemFor(spot);
  return (
    <Scaled width={width}>
      <SpotCard gem={gem} src={`/share-assets/avatar-${gem.avatar}.jpg`} variant={variant} fonts={FONTS} />
    </Scaled>
  );
}

/** Roughly how X lays out a post with a large link card: text, then the image with the domain on it. */
function XPost({ spot, variant }: { spot: number; variant: CardVariant }) {
  const gem = gemFor(spot);
  const link = `${SITE}${spotPath(spot)}`;
  return (
    <article style={{ width: 598, padding: "12px 16px", background: "#000", color: "#E7E9EA", font: "15px/20px system-ui, sans-serif", border: "1px solid #2F3336" }}>
      <div style={{ display: "flex", gap: 12 }}>
        <div style={{ width: 40, height: 40, borderRadius: "50%", background: "#16181C", display: "grid", placeItems: "center", flex: "none" }}>
          <TesoroMark size={22} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div>
            <b>Early Player</b> <span style={{ color: "#71767B" }}>@player · 1m</span>
          </div>
          <p style={{ margin: "2px 0 12px" }}>
            {shareText(gem)} <span style={{ color: "#1D9BF0" }}>{link}</span>
          </p>
          <div style={{ position: "relative", borderRadius: 16, overflow: "hidden", border: "1px solid #2F3336" }}>
            <Card spot={spot} variant={variant} width={514} />
            <span style={{ position: "absolute", left: 12, bottom: 12, padding: "0 4px", borderRadius: 4, background: "rgba(0,0,0,0.77)", fontSize: 13 }}>{SITE}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

function CompareView({ spot }: { spot: number }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 24 }}>
      {CARD_VARIANTS.map((v) => (
        <div key={v}>
          <p style={{ color: "#A7ACB4", margin: "0 0 8px", font: "700 13px var(--f-body)" }}>{v}</p>
          <XPost spot={spot} variant={v} />
        </div>
      ))}
    </div>
  );
}

type Args = { spot: number; variant: CardVariant };

const meta = {
  title: "Components/waitlist/Share card",
  args: { spot: 7, variant: "A" },
  argTypes: {
    spot: { control: { type: "number", min: 1, max: 999999, step: 1 } },
    variant: { control: "inline-radio", options: CARD_VARIANTS },
  },
  parameters: { layout: "centered", backgrounds: { disable: true } },
  decorators: [(Story) => <div style={{ padding: 24, background: "#15171a" }}><Story /></div>],
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The card at its real size (1200x630), the image X fetches for /spot/<n>. Change `spot` and `variant` in Controls. */
export const Card1200: Story = { name: "Card (full size)", render: (a) => <Card {...a} /> };

/** The share as it lands in a timeline. */
export const OnX: Story = { name: "On X", render: (a) => <XPost {...a} /> };

/** A and the three takes built on it (A1 rays, A2 card frame, A3 foil), side by side as posts. */
export const Compare: Story = { render: ({ spot }) => <CompareView spot={spot} /> };

/** Spots 1 to 12 draw all twelve gems once, in this order. */
export const EveryGem: Story = {
  name: "Every gem",
  render: ({ variant }) => (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 380px)", gap: 16 }}>
      {GEMS.map((_, i) => (
        <Card key={i} spot={i + 1} variant={variant} width={380} />
      ))}
    </div>
  ),
};

/** Long numbers: the layout has to hold six digits. */
export const BigSpot: Story = { name: "Spot #128,450", args: { spot: 128450 }, render: ({ spot }) => <CompareView spot={spot} /> };
