import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { PlayAgainRail } from "@/components/lobby/PlayAgainRail";
import { demoSnapshot } from "@/lib/chain/fixture";
import { lobbyDecorators } from "./support";

const meta = {
  title: "Components/lobby/PlayAgainRail",
  component: PlayAgainRail,
  decorators: lobbyDecorators,
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta<typeof PlayAgainRail>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The Account's latest finished Matches, to play again or pin. */
export const Default: Story = {};
export const NoMatchesYet: Story = {
  parameters: { data: { snapshot: (a: string) => ({ ...demoSnapshot(a), matches: [], funded: [] }) } },
};
export const SignedOut: Story = { parameters: { auth: "signed-out" } };
