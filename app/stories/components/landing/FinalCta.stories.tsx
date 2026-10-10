import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { FinalCta } from "@/components/landing/FinalCta";
import { inLanding, landingParameters } from "./support";

const meta = {
  title: "Components/landing/FinalCta",
  component: FinalCta,
  decorators: [inLanding],
  parameters: landingParameters,
} satisfies Meta<typeof FinalCta>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The last call to action, over the cave art. */
export const Dark: Story = {};
export const Light: Story = { parameters: { theme: "light" } };
export const Phone: Story = { globals: { viewport: { value: "phone390", isRotated: false } } };
