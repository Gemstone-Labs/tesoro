import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Card, Chip, ChainChip, Label, Meter, Row, Thumb } from "@/components/ui";

const meta = {
  title: "Components/ui/Card",
  component: Card,
  args: { children: "Card content. One corner size per class.", large: false, flush: false },
  argTypes: { as: { control: "inline-radio", options: ["div", "section", "article", "li"] } },
  decorators: [(Story) => <div style={{ maxWidth: 420 }}><Story /></div>],
} satisfies Meta<typeof Card>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The plain surface. Tick Large for more padding, Flush for none. */
export const Default: Story = {};

export const Large: Story = { args: { large: true } };

export const Flush: Story = { args: { flush: true, children: <div style={{ padding: 12 }}>Content sets its own padding.</div> } };

export const WithContent: Story = {
  args: {
    large: true,
    children: (
      <div className="stack">
        <Label>Your Lock</Label>
        <ChainChip chain="SOL" />
        <Meter value={0.4} label="Yield accrued" />
      </div>
    ),
  },
};

/** Thumb, Row and Chip live here too: they only exist inside cards. */
export const ThumbRowChip: Story = {
  args: {},
  render: () => (
    <div className="stack">
      <Row game="holdem" title="Buckshot Hold'em" meta="Live · 2 in Queue" cta="Play" href="/play?game=holdem" />
      <Row game="block-puzzle" title="Block Burst" meta="vs Otter · 171 – 140" when="2 min ago" delta={900} cta="Open" href="#match" />
      <Row thumb={<Thumb>D</Thumb>} title="Dana asks for 1,000" meta="Block Burst · 38 Matches" cta="Offer" ctaTone="money" onClick={() => {}} />
      <Row title="Static row" meta="No action" />
      <div className="hstack"><Chip>Neutral</Chip><Chip tone="strong">Strong</Chip><Chip tone="warn">Pending</Chip></div>
    </div>
  ),
};
