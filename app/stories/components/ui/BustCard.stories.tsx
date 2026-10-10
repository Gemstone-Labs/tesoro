import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { BustCard } from "@/components/ui";

const meta = {
  title: "Components/ui/BustCard",
  component: BustCard,
  args: {
    bust: "himExplain",
    size: 120,
    flip: false,
    children: (
      <div className="stack" style={{ gap: 4 }}>
        <b>How Gemas work</b>
        <p className="meta">Lock a Position, take an Advance, play with the Gemas. Your Principal stays yours.</p>
      </div>
    ),
  },
  argTypes: {
    bust: { control: "select", options: ["himWelcome", "himExplain", "himWin", "himLose", "himWaiting", "herBacking", "herEmpty", "herWaitingCrosschain", "duoHero", "duoWin"] },
    size: { control: { type: "range", min: 80, max: 260 } },
    children: { control: false },
  },
  decorators: [(Story) => <div style={{ maxWidth: 560 }}><Story /></div>],
} satisfies Meta<typeof BustCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Flipped: Story = { args: { flip: true, bust: "herBacking" } };
export const Large: Story = { args: { size: 200, bust: "himWin" } };
