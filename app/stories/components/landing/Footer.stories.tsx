import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Footer } from "@/components/landing/Footer";
import { inLanding, landingParameters } from "./support";

const meta = {
  title: "Components/landing/Footer",
  component: Footer,
  decorators: [inLanding],
  parameters: landingParameters,
} satisfies Meta<typeof Footer>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The page footer. */
export const Dark: Story = {};
export const Light: Story = { parameters: { theme: "light" } };
export const Phone: Story = { globals: { viewport: { value: "phone390", isRotated: false } } };
