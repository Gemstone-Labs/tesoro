import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { demoSnapshot, match } from "@/lib/chain/fixture";
import { PlayHome } from "@/app/(app)/play/PlayHome";
import { withScreen } from "./support/screen";

const meta = {
  title: "Screens/Play home",
  decorators: [withScreen],
  component: PlayHome,
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/play" } } },
} satisfies Meta<typeof PlayHome>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedIn: Story = {};

/** A Match still waiting for an opponent and one with an opponent found show under Continue, one card at a time on phones. */
export const WithOpenMatches: Story = {
  parameters: {
    data: {
      snapshot: (a: string) => {
        const s = demoSnapshot(a);
        const open = { ...match("block-puzzle", 1000, true, 1, [0, 0], a), status: "open" as const, session: null, winner: null, opponent: null };
        const live = { ...match("holdem", 2500, true, 3, [0, 0], a), status: "active" as const, winner: null };
        return { ...s, matches: [open, live, ...s.matches] };
      },
    },
  },
};

/** An Account with nothing yet: no Gemas, no history. */
export const NewAccount: Story = {
  parameters: {
    data: {
      snapshot: (a: string) => ({ ...demoSnapshot(a), positions: [], holdings: [], matches: [], funded: [], ownTotal: 0n, wonTotal: 0n }),
    },
  },
};

/** First load: the Account, the Requests and the leaderboard are still being read; recent wins stay hidden until some arrive. */
export const Loading: Story = {
  parameters: { data: { snapshot: null, settled: [] }, screen: { board: "loading", leaderboard: "loading" } },
};

export const SignedOut: Story = { parameters: { auth: "signed-out" } };
