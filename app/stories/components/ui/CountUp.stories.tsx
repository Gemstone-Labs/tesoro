import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { CountUp } from "@/components/ui";

const meta = {
  title: "Components/ui/CountUp",
  component: CountUp,
  args: { value: 1900, from: 0, duration: 800 },
  argTypes: { format: { control: false } },
  render: (args) => <span key={`${args.from}-${args.value}-${args.duration}`} style={{ fontSize: 40, fontWeight: 900 }} className="tnum"><CountUp {...args} /></span>,
} satisfies Meta<typeof CountUp>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Rolls in on load, like a won amount. Change a Control to see it roll again. */
export const RollsIn: Story = {};
export const Still: Story = { args: { from: undefined } };
