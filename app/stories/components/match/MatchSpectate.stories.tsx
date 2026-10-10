import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { MatchSpectate } from "@/components/match/MatchSpectate";
import { backed, match } from "@/lib/chain/fixture";
import type { ChainMatch } from "@/lib/chain/read";
import { withSpectated } from "../support/spectated";

const settled = (game: "block-puzzle" | "holdem" = "block-puzzle", win = true) => match(game, 1000, win, 5, [171, 55]);
const open = (): ChainMatch => ({ ...settled(), status: "open", seat: null, winner: null, session: null, sides: [settled().sides[0]] as unknown as ChainMatch["sides"] });
const live = (): ChainMatch => ({ ...settled(), status: "active", winner: null, session: null });

const meta = {
  title: "Components/match/MatchSpectate",
  component: MatchSpectate,
  args: { matchId: "1" },
  argTypes: { onSignIn: { control: false } },
  decorators: [withSpectated, (Story) => <div style={{ maxWidth: 900, margin: "0 auto" }}><Story /></div>],
  parameters: { layout: "fullscreen", shell: "app", spectated: settled() },
} satisfies Meta<typeof MatchSpectate>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Someone else's Match, read-only. */
export const Settled: Story = {};
export const HoldemSettled: Story = { parameters: { spectated: settled("holdem") } };
export const Draw: Story = { parameters: { spectated: (() => { const m = settled(); return { ...m, session: m.session && { ...m.session, result: "draw" as const } }; })() } };
export const Refunded: Story = { parameters: { spectated: { ...settled(), status: "refunded", session: null, winner: null } } };
export const Backed: Story = { parameters: { spectated: backed(settled(), "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM") } };
export const InPlay: Story = { parameters: { spectated: live() } };
export const WaitingForOpponent: Story = { parameters: { spectated: open() } };
export const SignedOut: Story = { args: { onSignIn: () => {} }, parameters: { auth: "signed-out" } };
export const Loading: Story = { parameters: { spectated: undefined } };
export const NotFound: Story = { parameters: { spectated: null } };
