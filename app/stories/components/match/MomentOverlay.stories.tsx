import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { MomentOverlay } from "@/components/match/MomentOverlay";

const meta = {
  title: "Components/match/MomentOverlay",
  component: MomentOverlay,
  args: { bust: "himWin", title: "You won", amount: 1900 },
  argTypes: { bust: { control: "select", options: ["himWin", "duoWin", "himWelcome", "herBacking"] } },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof MomentOverlay>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Shows for about 3 seconds, or until clicked. Without a `momentKey` it shows on every load. Motion is covered under Motion. */
export const Win: Story = {};
export const BackedWin: Story = { args: { bust: "duoWin", title: "Backed win", amount: 760 } };
