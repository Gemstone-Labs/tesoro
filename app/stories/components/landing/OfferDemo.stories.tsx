import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { OfferDemo } from "@/components/landing/OfferDemo";
import { inLanding, landingParameters } from "./support";

const meta = {
  title: "Components/landing/OfferDemo",
  component: OfferDemo,
  decorators: [inLanding, (Story) => <div style={{ maxWidth: 520, margin: "0 auto", padding: 24 }}><Story /></div>],
  parameters: landingParameters,
} satisfies Meta<typeof OfferDemo>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Pick an entry and the Player's share, and see who gets what. */
export const Dark: Story = {};
export const Light: Story = { parameters: { theme: "light" } };
