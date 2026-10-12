import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Slider } from "@/components/ui";

const meta = {
  title: "Components/ui/Slider",
  component: Slider,
  args: { label: "Horizon", value: 4, min: 1, max: 12, step: 1, display: "4 months", minLabel: "1 month", maxLabel: "12 months", onChange: () => {} },
  argTypes: { onChange: { control: false }, format: { control: false }, display: { control: "text" } },
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

/** The Player's share of the surplus, in 5% steps: past 12 steps the ruler shows five marks. */
export const Share: Story = { args: { label: "Player's share of the surplus", value: 40, min: 10, max: 90, step: 5, display: "40%", format: (v: number) => `${v}%` } };

/** A Gema amount with an odd maximum: the end labels come from minLabel / maxLabel. */
export const GemasToReturn: Story = { args: { label: "Gemas to return", value: 800, min: 0, max: 2430, step: 10, display: "800 Gemas", minLabel: "0", maxLabel: "2,430" } };
