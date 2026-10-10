import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Meter } from "@/components/ui";

const meta = {
  title: "Components/ui/Meter",
  component: Meter,
  args: { value: 0.4, label: "Yield accrued" },
  argTypes: { value: { control: { type: "range", min: 0, max: 1, step: 0.01 } } },
  decorators: [(Story) => <div style={{ maxWidth: 360 }}><Story /></div>],
} satisfies Meta<typeof Meter>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Partly: Story = {};
export const Empty: Story = { args: { value: 0 } };
export const Full: Story = { args: { value: 1 } };
