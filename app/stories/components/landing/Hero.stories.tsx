import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Hero } from "@/components/landing/Hero";
import { inLanding, landingParameters } from "./support";

const meta = {
  title: "Components/landing/Hero",
  component: Hero,
  decorators: [inLanding],
  parameters: landingParameters,
} satisfies Meta<typeof Hero>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The first screen: art, the promise and the two buttons. */
export const Dark: Story = {};
export const Light: Story = { parameters: { theme: "light" } };
export const Phone: Story = { globals: { viewport: { value: "phone390", isRotated: false } } };
