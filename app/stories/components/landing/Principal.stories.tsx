import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Principal } from "@/components/landing/Principal";
import { inLanding, landingParameters } from "./support";

const meta = {
  title: "Components/landing/Principal",
  component: Principal,
  decorators: [inLanding],
  parameters: landingParameters,
} satisfies Meta<typeof Principal>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Why the Principal is never played, with the vault that unlocks when Debt reaches zero. */
export const Dark: Story = {};
export const Light: Story = { parameters: { theme: "light" } };
export const Phone: Story = { globals: { viewport: { value: "phone390", isRotated: false } } };
