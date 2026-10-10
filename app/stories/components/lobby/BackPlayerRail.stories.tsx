import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { BackPlayerRail } from "@/components/lobby/BackPlayerRail";
import { lobbyDecorators } from "./support";

const meta = {
  title: "Components/lobby/BackPlayerRail",
  component: BackPlayerRail,
  decorators: lobbyDecorators,
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta<typeof BackPlayerRail>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Up to three live Requests, each with the Player's record. */
export const Default: Story = {};
export const Loading: Story = { parameters: { screen: { board: "loading" } } };
export const LoadFailed: Story = { parameters: { screen: { board: "error" } } };
