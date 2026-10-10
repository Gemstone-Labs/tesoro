import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { SkeletonCards } from "@/components/ui";

const meta = {
  title: "Components/ui/SkeletonCards",
  component: SkeletonCards,
  args: { count: 3, label: "Loading Matches", avatar: true },
  argTypes: { count: { control: { type: "range", min: 1, max: 6 } } },
  decorators: [(Story) => <div className="stack" style={{ maxWidth: 520 }}><Story /></div>],
} satisfies Meta<typeof SkeletonCards>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WithAvatar: Story = {};
export const NoAvatar: Story = { args: { avatar: false, count: 2 } };
