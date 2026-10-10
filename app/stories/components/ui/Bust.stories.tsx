import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Bust } from "@/components/ui";

const names = ["himWelcome", "himExplain", "himWin", "himLose", "himWaiting", "herBacking", "herEmpty", "herWaitingCrosschain", "duoHero", "duoWin"] as const;

const meta = {
  title: "Components/ui/Bust",
  component: Bust,
  args: { name: "himWelcome", width: 200 },
  argTypes: { name: { control: "select", options: names }, width: { control: { type: "range", min: 80, max: 500 } } },
} satisfies Meta<typeof Bust>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Single: Story = {};

export const All: Story = {
  render: () => (
    <div className="hstack" style={{ flexWrap: "wrap", alignItems: "flex-end", gap: 24 }}>
      {names.map((n) => (
        <figure key={n} className="stack" style={{ gap: 4, margin: 0 }}>
          <Bust name={n} width={160} />
          <figcaption className="mono meta" style={{ fontSize: 11 }}>{n}</figcaption>
        </figure>
      ))}
    </div>
  ),
};
