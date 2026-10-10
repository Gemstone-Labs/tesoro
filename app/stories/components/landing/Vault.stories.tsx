import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Vault } from "@/components/landing/Vault";
import { Picture } from "@/components/landing/Picture";
import { inLanding, landingParameters } from "./support";

const meta = {
  title: "Components/landing/Vault",
  component: Vault,
  decorators: [inLanding, (Story) => <div style={{ maxWidth: 420, margin: "0 auto", padding: 24 }}><Story /></div>],
  parameters: landingParameters,
  args: {
    locked: <Picture k="step1" sizes="260px" className="closed" />,
    open: <Picture k="step5" sizes="260px" className="open" />,
  },
  argTypes: { locked: { control: false }, open: { control: false } },
} satisfies Meta<typeof Vault>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A Position as a vault: yield fills the Debt meter, then it unlocks. It loops while in view, and stays on one frame with reduced motion. */
export const Dark: Story = {};
export const Light: Story = { parameters: { theme: "light" } };
