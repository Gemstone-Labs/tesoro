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

/** Three slides that advance on their own (not with reduced motion). Pick an entry, then Enter or Practice. */
export const Default: Story = {};
export const BusyQueues: Story = { parameters: { screen: { queueDepth: { "block-puzzle": 4, holdem: 2, "trading-duel": 1 } } } };
export const SignedOut: Story = { parameters: { auth: "signed-out" } };
export const FewGemas: Story = {
  parameters: { data: { snapshot: null } },
};
