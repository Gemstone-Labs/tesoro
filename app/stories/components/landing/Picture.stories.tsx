import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Picture } from "@/components/landing/Picture";
import { inLanding, landingParameters } from "./support";

const meta = {
  title: "Components/landing/Picture",
  component: Picture,
  decorators: [inLanding, (Story) => <div style={{ maxWidth: 720, margin: "0 auto", padding: 24 }}><Story /></div>],
  parameters: landingParameters,
  args: { k: "step1", sizes: "(max-width: 720px) 100vw, 720px" },
  argTypes: {
    k: { control: "select", options: ["heroBack", "heroMid", "heroFront", "heroMobile", "heroLight", "heroLightMobile", "himGuide", "herBacker", "finalBack", "finalDuo", "finalRope", "finalMobile", "step1", "step2", "step3", "step4", "step5"] },
    mobile: { control: "select", options: [undefined, "heroMobile", "heroLightMobile", "finalMobile"] },
  },
} satisfies Meta<typeof Picture>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Astra's art as AVIF and WebP at several widths. Pick the art in Controls. */
export const Step: Story = {};
export const Backer: Story = { args: { k: "herBacker" } };
export const Guide: Story = { args: { k: "himGuide" } };
