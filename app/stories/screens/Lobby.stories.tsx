import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { PublicKey } from "@solana/web3.js";
import { userEvent, within } from "storybook/test";
import type { BackingBoard } from "@/lib/chain/backing";
import { demoSnapshot, match } from "@/lib/chain/fixture";
import Lobby from "@/app/(app)/lobby/page";
import { DEMO_ME } from "../support/data";
import { demoKey, withScreen } from "./support/screen";

const meta = {
  title: "Screens/Lobby",
  decorators: [withScreen],
  component: Lobby,
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/lobby" } } },
} satisfies Meta<typeof Lobby>;
export default meta;
type Story = StoryObj<typeof meta>;

export const SignedIn: Story = {};

/** A Match still waiting for an opponent and one with an opponent found show under Continue. */
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

/** On a Break: the hero shows the Break notice where Play now would be. */
export const OnABreak: Story = { parameters: { screen: { away: "break" } } };

/** Self-Excluded: the hero shows the Self-Exclusion notice instead of Play now. */
export const SelfExcluded: Story = { parameters: { screen: { away: "self-exclusion" } } };

/** Your own live Request sits on the "Back a player" shelf (best record, so it leads) and its card says "Your Request". */
export const YourOwnRequestOnTheShelf: Story = {
  parameters: {
    data: {
      board: (demo: BackingBoard): BackingBoard => ({
        requests: [
          {
            address: new PublicKey(demoKey(931)),
            nonce: 931n,
            player: DEMO_ME,
            game: "holdem",
            entry: 1000,
            expiresAt: Math.floor(Date.now() / 1000) + 18 * 3600,
            status: "open",
            live: true,
            record: { matches: 80, wins: 62 },
            pnl: [],
          },
          ...demo.requests,
        ],
        offers: [],
        fetchedAt: Date.now(),
      }),
    },
  },
};

/** Typing in the top-bar search turns the Lobby into the matching Games only. */
export const SearchResults: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.type(await within(canvasElement.ownerDocument.body).findByRole("searchbox", { name: "Search games" }), "hold");
  },
};

/** A search that matches no Game. */
export const SearchNoMatch: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.type(await within(canvasElement.ownerDocument.body).findByRole("searchbox", { name: "Search games" }), "zzz");
  },
};

/** The "Back a player" shelf when the Requests could not be read: the failure note and Try again. */
export const BackingRequestsFailed: Story = { parameters: { screen: { board: "error" } } };

/** The "Back a player" shelf when nobody is asking to be backed. */
export const NoBackingRequests: Story = { parameters: { data: { board: { requests: [], offers: [], fetchedAt: Date.now() } } } };
