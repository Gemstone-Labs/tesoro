import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { SidebarBody } from "@/components/shell/Sidebar";
import { demoSnapshot, match } from "@/lib/chain/fixture";
import type { ChainMatch } from "@/lib/chain/read";
import { DEMO_ME } from "../../support/data";

const soon = (mins: number) => Math.floor(Date.now() / 1000) + mins * 60;
const open = (a: string, game: ChainMatch["game"], mins: number, extra: Partial<ChainMatch> = {}): ChainMatch => ({
  ...match(game, 1000, true, mins, [0, 0], a),
  status: "open",
  session: null,
  winner: null,
  opponent: null,
  deadline: soon(50 - mins),
  ...extra,
});
const withOpen = (make: (a: string) => ChainMatch[]) => (address: string) => {
  const s = demoSnapshot(address);
  return { ...s, matches: [...make(s.accountKey.toBase58()), ...s.matches] };
};

const meta = {
  title: "Components/shell/Sidebar",
  component: SidebarBody,
  parameters: { layout: "fullscreen", nextjs: { navigation: { pathname: "/lobby" } } },
  argTypes: { onNavigate: { control: false } },
  decorators: [
    (Story) => (
      <aside className="sidebar" style={{ display: "flex", flexDirection: "column", position: "relative", width: "var(--side-w)", height: "100vh", minHeight: 640 }}>
        <Story />
      </aside>
    ),
  ],
} satisfies Meta<typeof SidebarBody>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The current page is lit. Change the story's path in the toolbar's URL to see another one lit. */
export const OnLobby: Story = {};
export const OnWallet: Story = { parameters: { nextjs: { navigation: { pathname: "/wallet" } } } };
export const OnHelp: Story = { parameters: { nextjs: { navigation: { pathname: "/help" } } } };

/** Two open Matches, one with an opponent found (Hold'em, your move). */
export const OpenMatches: Story = {
  parameters: {
    data: {
      snapshot: withOpen((a) => [
        open(a, "block-puzzle", 1),
        { ...open(a, "holdem", 3), status: "active" },
      ]),
    },
  },
};
/** One open Match, still looking for an opponent. */
export const WaitingOnly: Story = { parameters: { data: { snapshot: withOpen((a) => [open(a, "block-puzzle", 1)]) } } };
/** Four open Matches. */
export const ManyOpen: Story = {
  parameters: {
    data: {
      snapshot: withOpen((a) => [
        open(a, "block-puzzle", 1),
        { ...open(a, "holdem", 3), status: "active" },
        open(a, "trading-duel", 5, { challenge: true }),
        open(a, "block-puzzle", 8),
      ]),
    },
  },
};
export const OnMatches: Story = { ...OpenMatches, parameters: { ...OpenMatches.parameters, nextjs: { navigation: { pathname: "/matches" } } } };
export const SignedOut: Story = { parameters: { auth: "signed-out" } };
export const OnProfile: Story = { ...OpenMatches, parameters: { ...OpenMatches.parameters, nextjs: { navigation: { pathname: `/account/${DEMO_ME}` } } } };
