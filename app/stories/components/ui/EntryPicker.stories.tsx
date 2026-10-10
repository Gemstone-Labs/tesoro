import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { EntryPicker } from "@/components/ui";

const meta = {
  title: "Components/ui/EntryPicker",
  component: EntryPicker,
  args: { value: 1000, legend: "Entry", onChange: () => {} },
  argTypes: {
    value: { control: "inline-radio", options: [500, 1000, 2500] },
    maxAffordable: { control: "number" },
    onChange: { control: false },
    isDisabled: { control: false },
  },
  decorators: [(Story) => <div style={{ maxWidth: 420 }}><Story /></div>],
  render: function Render(args) {
    const [v, setV] = useState(args.value);
    return <EntryPicker {...args} value={v} onChange={setV} />;
  },
} satisfies Meta<typeof EntryPicker>;
export default meta;
type Story = StoryObj<typeof meta>;

/** 500 / 1,000 / 2,500. The chosen entry is emerald and carries the Gema mark. */
export const Default: Story = {};

/** Entries above what the Player can afford are disabled. */
export const Limited: Story = { args: { maxAffordable: 1200 } };

export const NothingAffordable: Story = { args: { value: 500, maxAffordable: 100 } };
