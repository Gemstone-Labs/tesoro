import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { GemaAmount } from "@/components/ui";

const meta = {
  title: "Components/ui/GemaAmount",
  component: GemaAmount,
  args: { value: 1240, size: "md", glint: false, sign: false, mark: true },
  argTypes: { size: { control: "inline-radio", options: ["sm", "md", "lg", "xl"] } },
} satisfies Meta<typeof GemaAmount>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Big: Story = { args: { value: 15000, size: "xl", glint: true } };
/** Gains and losses get a + or − as a second signal. */
export const Gain: Story = { args: { value: 1900, sign: true } };
export const Loss: Story = { args: { value: -1000, sign: true } };
export const NoMark: Story = { args: { mark: false } };
export const Sizes: Story = {
  render: () => (
    <div className="hstack" style={{ gap: 20 }}>
      <GemaAmount value={1240} size="sm" /><GemaAmount value={1240} size="md" /><GemaAmount value={1240} size="lg" /><GemaAmount value={1240} size="xl" />
    </div>
  ),
};
