import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { inLanding, landingParameters } from "./support";

const meta = {
  title: "Components/landing/HowItWorks",
  component: HowItWorks,
  decorators: [inLanding],
  parameters: landingParameters,
} satisfies Meta<typeof HowItWorks>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The five steps from a Position to a Match, as a map. */
export const Dark: Story = {};
export const Light: Story = { parameters: { theme: "light" } };
export const Phone: Story = { globals: { viewport: { value: "phone390", isRotated: false } } };
