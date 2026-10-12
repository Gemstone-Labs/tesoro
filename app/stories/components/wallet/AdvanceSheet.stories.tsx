import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { AdvanceSheet } from "@/app/(app)/wallet/AdvanceSheet";
import { positions } from "@/lib/mock";

const meta = {
  title: "Components/wallet/AdvanceSheet",
  component: AdvanceSheet,
  args: { position: positions[1], onClose: () => {} },
  argTypes: { position: { control: "object" }, onClose: { control: false } },
} satisfies Meta<typeof AdvanceSheet>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Pick a Horizon, see the Gemas and the Unlock Estimate, take the Advance. */
export const OnEthPosition: Story = {};
export const OnSolPosition: Story = { args: { position: positions[0] } };
export const OnHypePosition: Story = { args: { position: positions[2] } };
export const Closed: Story = { args: { position: null } };

