import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Multichain } from "@/components/landing/Multichain";
import { inLanding, landingParameters } from "./support";

const meta = {
  title: "Components/landing/Multichain",
  component: Multichain,
  decorators: [inLanding],
  parameters: landingParameters,
} satisfies Meta<typeof Multichain>;
export default meta;
type Story = StoryObj<typeof meta>;

/** One ledger, every chain. The 3D stage needs WebGL; without it the poster shows. */
export const Dark: Story = {};
export const Light: Story = { parameters: { theme: "light" } };
export const Phone: Story = { globals: { viewport: { value: "phone390", isRotated: false } } };
