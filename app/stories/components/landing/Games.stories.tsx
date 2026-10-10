import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Games } from "@/components/landing/Games";
import { inLanding, landingParameters } from "./support";

const meta = {
  title: "Components/landing/Games",
  component: Games,
  decorators: [inLanding],
  parameters: landingParameters,
} satisfies Meta<typeof Games>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Two games on a shelf; the stage plays a loop of the one picked. */
export const Dark: Story = {};
export const Light: Story = { parameters: { theme: "light" } };
export const Phone: Story = { globals: { viewport: { value: "phone390", isRotated: false } } };
