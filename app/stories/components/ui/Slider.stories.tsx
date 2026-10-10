import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Slider } from "@/components/ui";

const meta = {
  title: "Components/ui/Slider",
  component: Slider,
  args: { label: "Horizon", value: 4, min: 1, max: 12, step: 1, display: "4 months", minLabel: "1 month", maxLabel: "12 months", onChange: () => {} },
  argTypes: { onChange: { control: false }, display: { control: "text" } },
  decorators: [(Story) => <div style={{ maxWidth: 420 }}><Story /></div>],
  render: function Render(args) {
    const [v, setV] = useState(args.value);
    return <Slider {...args} value={v} onChange={setV} display={typeof args.display === "string" ? args.display.replace(/^\d+/, String(v)) : args.display} />;
  },
} satisfies Meta<typeof Slider>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Horizon, 1 to 12 months. */
export const Horizon: Story = {};

/** The Player's share of the surplus, in 5% steps: too many steps for notches. */
export const Share: Story = { args: { label: "Player's share", value: 40, min: 0, max: 100, step: 5, display: "40%", minLabel: "0%", maxLabel: "100%" } };
