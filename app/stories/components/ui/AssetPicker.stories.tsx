import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { AssetPicker } from "@/components/ui";

const meta = {
  title: "Components/ui/AssetPicker",
  component: AssetPicker,
  args: { value: 0, compact: false, onChange: () => {} },
  argTypes: { value: { control: "inline-radio", options: [0, 1, 2] }, onChange: { control: false } },
  render: function Render(args) {
    const [v, setV] = useState(args.value);
    return <AssetPicker {...args} value={v} onChange={setV} />;
  },
} satisfies Meta<typeof AssetPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The asset a Trading Duel trades. Pale when chosen, never emerald. */
export const Default: Story = {};
export const Compact: Story = { args: { compact: true } };
export const Hype: Story = { args: { value: 2 } };
