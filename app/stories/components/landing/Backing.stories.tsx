import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Backing } from "@/components/landing/Backing";
import { inLanding, landingParameters } from "./support";

const meta = {
  title: "Components/landing/Backing",
  component: Backing,
  decorators: [inLanding],
  parameters: landingParameters,
} satisfies Meta<typeof Backing>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Back a Player, with a live Offer you can change. */
export const Dark: Story = {};
export const Light: Story = { parameters: { theme: "light" } };
export const Phone: Story = { globals: { viewport: { value: "phone390", isRotated: false } } };
