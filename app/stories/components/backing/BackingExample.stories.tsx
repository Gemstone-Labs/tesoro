import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import "@/app/(app)/backing/backing.css";
import { BackingExample } from "@/app/(app)/backing/BackingExample";

const meta = {
  title: "Components/backing/BackingExample",
  component: BackingExample,
  args: { onPost: () => {} },
  argTypes: { onPost: { control: false } },
  parameters: { layout: "padded" },
  decorators: [(Story) => <div className="bk" style={{ maxWidth: 980 }}><Story /></div>],
} satisfies Meta<typeof BackingExample>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A worked Offer, with the real split rule and the 1% Leaderboard Fee, shown while there are no Requests. */
export const Default: Story = {};
