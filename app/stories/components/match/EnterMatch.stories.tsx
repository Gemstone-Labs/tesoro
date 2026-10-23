import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { EnterMatch } from "@/components/match/EnterMatch";
import { demoSnapshot } from "@/lib/chain/fixture";
import type { GameId } from "@/lib/mock";

type Props = { kind: "queue" | "challenge-new"; entry: number; game?: GameId; asset?: 0 | 1 | 2 };
const Enter = (p: Props) => <EnterMatch {...p} />;

const meta = {
  title: "Components/match/EnterMatch",
  component: Enter,
  args: { kind: "queue", entry: 1000, game: "block-puzzle" },
  argTypes: { kind: { control: "inline-radio", options: ["queue", "challenge-new"] }, game: { control: "inline-radio", options: ["block-puzzle", "holdem", "trading-duel"] } },
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/play/queue" } } },
  decorators: [(Story) => <div style={{ maxWidth: 820, margin: "0 auto" }}><Story /></div>],
} satisfies Meta<typeof Enter>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The page the Lobby's Enter button opens. With no wallet to sign, it waits at the first step. */
export const Queue: Story = {};
export const TradingDuel: Story = { args: { kind: "queue", entry: 1000, game: "trading-duel", asset: 1 } };
export const NewChallenge: Story = { args: { kind: "challenge-new", entry: 1000, game: "holdem" } };
export const SignedOut: Story = { parameters: { auth: "signed-out" } };
export const NotEnoughGemas: Story = {
  args: { entry: 1000 },
  parameters: { data: { snapshot: (a: string) => ({ ...demoSnapshot(a), holdings: [], positions: [], ownTotal: 0n, wonTotal: 0n }) } },
};
