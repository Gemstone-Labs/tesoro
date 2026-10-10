import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Gemas } from "@/components/landing/Gemas";
import { inLanding, landingParameters } from "./support";

const meta = {
  title: "Components/landing/Gemas",
  component: Gemas,
  decorators: [inLanding],
  parameters: landingParameters,
} satisfies Meta<typeof Gemas>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Three beats on what a Gema is, beside the 3D Gema. The 3D stage needs WebGL; without it the poster shows. */
export const Dark: Story = {};
export const Light: Story = { parameters: { theme: "light" } };
export const Phone: Story = { globals: { viewport: { value: "phone390", isRotated: false } } };
