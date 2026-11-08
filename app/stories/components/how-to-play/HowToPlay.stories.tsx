import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { HowToPlay } from "@/components/how-to-play";
import { Button } from "@/components/ui";

const phone = { globals: { viewport: { value: "phone390", isRotated: false } } };
const desktop = { globals: { viewport: { value: "desktop1440", isRotated: false } } };

const meta = {
  title: "Components/how-to-play/HowToPlay",
  component: HowToPlay,
  args: { game: "block-puzzle", open: true, end: "game-page", onClose: () => {} },
  argTypes: {
    game: { control: "select", options: ["block-puzzle", "holdem", "trading-duel", "vanguard"] },
    end: { control: "inline-radio", options: ["game-page", "first-practice", "practice-menu"] },
    onClose: { control: false },
  },
  render: function Render(args) {
    const [open, setOpen] = useState(args.open);
    return (
      <>
        <Button onClick={() => setOpen(true)}>How to play</Button>
        <HowToPlay {...args} open={open} onClose={() => setOpen(false)} />
      </>
    );
  },
} satisfies Meta<typeof HowToPlay>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Clips live in public/art/how-to-play (ticket 05); until they exist the step shows a plain frame. Step with the arrow keys or Next. */
export const BlockBurstPhone: Story = { ...phone };
export const BlockBurstDesktop: Story = { ...desktop };
export const HoldemPhone: Story = { ...phone, args: { game: "holdem" } };
export const HoldemDesktop: Story = { ...desktop, args: { game: "holdem" } };
export const TradingDuelPhone: Story = { ...phone, args: { game: "trading-duel" } };
export const TradingDuelDesktop: Story = { ...desktop, args: { game: "trading-duel" } };
export const VanguardPhone: Story = { ...phone, args: { game: "vanguard" } };
export const VanguardDesktop: Story = { ...desktop, args: { game: "vanguard" } };

/** Last step reads Practice free + Done on the game page, Start practice before the first Practice, Done from the pause card. */
export const EndFirstPractice: Story = { ...phone, args: { end: "first-practice" } };
export const EndPracticeMenu: Story = { ...phone, args: { end: "practice-menu" } };
