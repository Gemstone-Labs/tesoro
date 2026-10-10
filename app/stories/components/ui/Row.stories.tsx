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
  decorators: [(Story) => <div style={{ maxWidth: 520 }}><Story /></div>],
} satisfies Meta<typeof Row>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A button row. Emerald call to action only where Gemas move. */
export const Button: Story = { args: { thumb: <Thumb>D</Thumb>, onClick: () => {} } };

export const Link: Story = { args: { thumb: <Thumb variant="poker">A♠K</Thumb>, title: "Heads-up Hold'em", meta: "Live · 2 in Queue", cta: "Play", ctaTone: "neutral", href: "/play?game=holdem" } };

export const Static: Story = { args: { title: "Static row", meta: "No action", cta: undefined } };
