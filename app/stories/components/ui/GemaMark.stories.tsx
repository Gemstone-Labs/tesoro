import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { GemaMark } from "@/components/ui";

const meta = {
  title: "Components/ui/GemaMark",
  component: GemaMark,
  args: { size: 30, glint: false },
  argTypes: { size: { control: { type: "range", min: 12, max: 160 } } },
} satisfies Meta<typeof GemaMark>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
/** The glint runs on the balance only, and is off with reduced motion. */
export const Glint: Story = { args: { glint: true } };
export const Sizes: Story = {
  render: () => (
    <div className="hstack" style={{ gap: 20 }}>
      <GemaMark size={14} /><GemaMark size={16} /><GemaMark size={20} /><GemaMark size={30} /><GemaMark size={64} />
    </div>
  ),
};
