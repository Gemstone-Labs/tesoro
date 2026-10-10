import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { demoSnapshot, match } from "@/lib/chain/fixture";
import Lobby from "@/app/(app)/lobby/page";
import { withScreen } from "./support/screen";

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

export const Loading: Story = { parameters: { data: { snapshot: null } } };

export const SignedOut: Story = { parameters: { auth: "signed-out" } };
