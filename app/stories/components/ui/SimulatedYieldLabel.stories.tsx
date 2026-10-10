import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { SimulatedYieldLabel } from "@/components/ui";

const meta = {
  title: "Components/ui/SimulatedYieldLabel",
  component: SimulatedYieldLabel,
  args: { align: "left" },
  argTypes: { align: { control: "inline-radio", options: ["left", "center", "right"] } },
  decorators: [(Story) => <div style={{ maxWidth: 360 }}><Story /></div>],
} satisfies Meta<typeof SimulatedYieldLabel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Centered: Story = { args: { align: "center" } };
