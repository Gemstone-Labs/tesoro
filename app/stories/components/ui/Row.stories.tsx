import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Row, Thumb } from "@/components/ui";

const meta = {
  title: "Components/ui/Row",
  component: Row,
  args: { title: "Dana asks for 1,000", meta: "Block Puzzle · 38 Matches · 61% won", cta: "Offer", ctaTone: "money" },
  argTypes: {
    ctaTone: { control: "inline-radio", options: ["neutral", "money"] },
    thumb: { control: false },
    onClick: { control: false },
  },
  decorators: [(Story) => <div style={{ maxWidth: 760 }}><Story /></div>],
} satisfies Meta<typeof Row>;
export default meta;
type Story = StoryObj<typeof meta>;

/** With a Game: a banner over its hero art, the Gema change on a glass chip. */
export const Won: Story = { args: { game: "block-puzzle", title: "Block Puzzle", meta: "vs Otter · 171 – 140", when: "2 min ago", delta: 900, cta: "Open", ctaTone: "neutral", href: "#won" } };
export const Lost: Story = { args: { game: "holdem", title: "Hold'em", meta: "vs Lynx · Entry 500", when: "1 h ago", delta: -500, cta: "Open", ctaTone: "neutral", href: "#lost" } };
export const Draw: Story = { args: { game: "trading-duel", title: "Trading Duel", meta: "vs Heron · SOL", when: "3 h ago", delta: 0, cta: "Open", ctaTone: "neutral", href: "#draw" } };
export const Game: Story = { args: { game: "holdem", title: "Heads-up Hold'em", meta: "Live · 2 in Queue", cta: "Play", ctaTone: "neutral", href: "#game" } };

/** A button row. Emerald call to action only where Gemas move. */
export const Button: Story = { args: { thumb: <Thumb>D</Thumb>, onClick: () => {} } };

export const Link: Story = { args: { thumb: <Thumb variant="poker">A♠K</Thumb>, title: "Heads-up Hold'em", meta: "Live · 2 in Queue", cta: "Play", ctaTone: "neutral", href: "/play?game=holdem" } };

export const Static: Story = { args: { title: "Static row", meta: "No action", cta: undefined } };
