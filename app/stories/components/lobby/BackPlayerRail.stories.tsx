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

/** The Backing explainer, then live Requests strongest record first: record, P&L and Back for. One Player is behind, one is new. */
export const Default: Story = {};
export const NoRequests: Story = { parameters: { data: { board: { requests: [], offers: [], fetchedAt: 0 } } } };
export const Loading: Story = { parameters: { screen: { board: "loading" } } };
export const LoadFailed: Story = { parameters: { screen: { board: "error" } } };
