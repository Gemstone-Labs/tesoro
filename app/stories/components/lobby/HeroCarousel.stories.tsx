import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { HeroCarousel } from "@/components/lobby/HeroCarousel";
import { lobbyDecorators } from "./support";

const meta = {
  title: "Components/lobby/HeroCarousel",
  component: HeroCarousel,
  decorators: lobbyDecorators,
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta<typeof HeroCarousel>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Two featured Games that advance on their own (not with reduced motion). Play now opens the Game's page. */
export const Default: Story = {};
export const BusyQueues: Story = { parameters: { screen: { queueDepth: { "block-puzzle": 4, holdem: 2 } } } };
/** Nobody waiting anywhere: Block Burst leads, and the strip points to Challenge a friend. */
export const EmptyQueues: Story = { parameters: { screen: { queueDepth: { "block-puzzle": 0, holdem: 0, "trading-duel": 0 } } } };
/** Only Trading Duel has someone waiting, so the hero opens on it. */
export const OnlyTradingDuelBusy: Story = { parameters: { screen: { queueDepth: { "block-puzzle": 0, holdem: 0, "trading-duel": 2 } } } };
export const SignedOut: Story = { parameters: { auth: "signed-out" } };
export const FewGemas: Story = {
  parameters: { data: { snapshot: null } },
};
