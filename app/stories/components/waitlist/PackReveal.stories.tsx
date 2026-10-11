import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";
import "@/components/waitlist/waitlist.css";
import "@/components/waitlist/pack.css";
import { PackReveal } from "@/components/waitlist/PackReveal";
import { CARD_VARIANTS, SHARE_CARD, type CardVariant } from "@/components/waitlist/SpotCard";
import { gemFor, shareText, spotPath } from "@/lib/waitlist-spot";

type Args = { spot: number; variant: CardVariant; sealed: boolean };

/** Close puts a Replay button in its place, so the pack can be torn again without reloading. */
function Demo({ spot, variant, sealed }: Args) {
  const [run, setRun] = useState(0);
  const [open, setOpen] = useState(true);
  const gem = gemFor(spot);
  const share = `https://x.com/intent/post?text=${encodeURIComponent(shareText(gem))}&url=${encodeURIComponent(`https://tesoro-fawn.vercel.app${spotPath(spot)}`)}`;
  return (
    <div className="wl" style={{ height: "100vh", minHeight: 0, display: "grid", placeItems: "center" }}>
      {open ? (
        <PackReveal
          key={`${run}-${spot}-${variant}-${sealed}`}
          gem={gem}
          variant={variant}
          shareHref={share}
          tryHref="/lobby"
          sealed={sealed}
          onClose={() => setOpen(false)}
        />
      ) : (
        <button
          type="button"
          className="btn neutral cut cut-btn"
          onClick={() => {
            setRun((r) => r + 1);
            setOpen(true);
          }}
        >
          Replay the pack
        </button>
      )}
    </div>
  );
}

const meta = {
  title: "Components/waitlist/Pack reveal",
  render: (a) => <Demo {...a} />,
  args: { spot: 7, variant: SHARE_CARD, sealed: true },
  argTypes: {
    spot: { control: { type: "number", min: 1, max: 999999, step: 1 } },
    variant: { control: "inline-radio", options: CARD_VARIANTS },
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<Args>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The sealed pack. Swipe across the top to rip it, or tap it, or press Rip it open. Escape or × closes. */
export const Sealed: Story = {};

/** Straight to the card, as "See your card" and reduced motion show it. */
export const Opened: Story = { args: { sealed: false } };

/** Ripped by the button: the burst plays, then the card and its actions. */
export const Ripped: Story = {
  args: { spot: 1 },
  play: async () => {
    const page = within(document.body);
    await userEvent.click(page.getByRole("button", { name: "Rip it open" }));
    await expect(await page.findByRole("heading", { name: /You pulled the Ruby Jaguar/ }, { timeout: 4000 })).toBeInTheDocument();
    await expect(page.getByRole("link", { name: "Share your card" }).getAttribute("href")).toContain(encodeURIComponent("/spot/1"));
  },
};

/** A phone, with a six-digit spot. */
export const Phone: Story = { args: { spot: 128450 }, globals: { viewport: { value: "phone390", isRotated: false } } };
