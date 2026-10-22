import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { demoSnapshot } from "@/lib/chain/fixture";
import { chainMatch } from "./support/matches";
import Matches from "@/app/(app)/matches/page";

const meta = {
  title: "Screens/Matches",
  component: Matches,
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/matches" } } },
} satisfies Meta<typeof Matches>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Every finished Match of the demo Account, paginated, with a filter per Game. */
export const History: Story = {};

export const OnlyHoldem: Story = { parameters: { nextjs: { navigation: { pathname: "/matches", query: { game: "holdem" } } } } };

export const SecondPage: Story = { parameters: { nextjs: { navigation: { pathname: "/matches", query: { page: "2" } } } } };

export const Empty: Story = {
  parameters: { data: { snapshot: (a: string) => ({ ...demoSnapshot(a), matches: [], funded: [] }) } },
};

export const Loading: Story = { parameters: { data: { snapshot: null } } };

export const SignedOut: Story = { parameters: { auth: "signed-out" } };

const secs = () => Math.floor(Date.now() / 1000);

/** A Match past its settle time sits above the history: "Delayed, refunds by ...". */
export const WithDelayed: Story = {
  parameters: {
    data: {
      snapshot: (a: string) => {
        const base = demoSnapshot(a);
        const m = chainMatch("block-puzzle", "active");
        const late = { ...m, deadline: secs() + 1800, session: m.session && { ...m.session, deadline: secs() - 900, openerDeadline: secs() - 900 } };
        return { ...base, matches: [late, ...base.matches] };
      },
    },
  },
};

/** Your Matches could not be read: "Your Matches couldn't be loaded" with Try again. */
export const LoadFailed: Story = { parameters: { data: { snapshotError: "Loading your Account took too long." } } };

/** Every result switched off in the filter: "No Matches with these results" and a Show all results button. */
export const NoMatchesWithTheseResults: Story = { parameters: { nextjs: { navigation: { pathname: "/matches", query: { result: "none" } } } } };

/** Filtered to Trading Duel while none has finished: "No finished Trading Duel Matches yet". */
export const NoFinishedTradingDuel: Story = {
  parameters: {
    nextjs: { navigation: { pathname: "/matches", query: { game: "trading-duel" } } },
    data: {
      snapshot: (a: string) => {
        const s = demoSnapshot(a);
        return { ...s, matches: s.matches.filter((m) => m.game !== "trading-duel"), funded: s.funded.filter((m) => m.game !== "trading-duel") };
      },
    },
  },
};
