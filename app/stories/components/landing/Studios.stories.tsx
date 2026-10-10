import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Studios } from "@/components/landing/Studios";
import { inLanding, landingParameters } from "./support";

const meta = {
  title: "Components/landing/Studios",
  component: Studios,
  decorators: [inLanding],
  parameters: landingParameters,
} satisfies Meta<typeof Studios>;
export default meta;
type Story = StoryObj<typeof meta>;

/** For studios who want to build a Game on Tesoro. */
export const Dark: Story = {};
export const Light: Story = { parameters: { theme: "light" } };
export const Phone: Story = { globals: { viewport: { value: "phone390", isRotated: false } } };
