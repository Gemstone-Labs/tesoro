import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Nav } from "@/components/landing/Nav";
import { inLanding, landingParameters } from "./support";

const meta = {
  title: "Components/landing/Nav",
  component: Nav,
  decorators: [inLanding],
  parameters: landingParameters,
} satisfies Meta<typeof Nav>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The top bar: logo, section links, theme switch and Launch app. It turns solid after a little scroll. */
export const Dark: Story = {};
export const Light: Story = { parameters: { theme: "light" } };
export const Phone: Story = { globals: { viewport: { value: "phone390", isRotated: false } } };
