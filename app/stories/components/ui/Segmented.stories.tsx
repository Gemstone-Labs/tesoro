import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Segmented } from "@/components/ui";

const meta = {
  title: "Components/ui/Segmented",
  component: Segmented,
  args: { label: "View", value: "requests", onChange: () => {}, options: [] },
  argTypes: { onChange: { control: false }, options: { control: false } },
  render: function Render(args) {
    const [v, setV] = useState<string>(args.value);
    return (
      <div style={{ maxWidth: 360 }}>
        <Segmented {...args} value={v} onChange={setV} />
      </div>
    );
  },
} satisfies Meta<typeof Segmented>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A two-way view switch, as on Backing: one cut rail, the chosen option a lit steel piece. */
export const TwoWay: Story = {
  args: { options: [{ value: "requests", label: "Requests" }, { value: "mine", label: "My Backings (2)" }] },
};
export const ThreeWay: Story = {
  args: { value: "all", options: [{ value: "all", label: "All" }, { value: "open", label: "Open" }, { value: "done", label: "Done" }] },
};
