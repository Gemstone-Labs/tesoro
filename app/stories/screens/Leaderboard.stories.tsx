import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import Leaderboard from "@/app/(app)/leaderboard/page";
import { userEvent, within } from "storybook/test";
import { withScreen } from "./support/screen";

const meta = {
  title: "Screens/Leaderboard",
  component: Leaderboard,
  decorators: [withScreen],
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/leaderboard" } } },
} satisfies Meta<typeof Leaderboard>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A season in progress: the pool, the table (you are third), the prize scale and last week's winners. */
export const LiveSeason: Story = { parameters: { screen: { leaderboard: "live" } } };

/** You are 23rd: page 1 offers "You’re 23rd" to jump to your page. */
export const YouOnPageTwo: Story = { parameters: { screen: { leaderboard: "deep" } } };

/** A phone: the chest spans the card over the Pool figure. */
export const LiveSeasonPhone: Story = {
  globals: { viewport: { value: "phone360", isRotated: false } },
  parameters: { screen: { leaderboard: "live" } },
};
export const LiveSeasonSignedOut: Story = { parameters: { screen: { leaderboard: "live" }, auth: "signed-out" } };

/** The season before has ended and its prizes are still being paid. */
export const PrizesBeingPaid: Story = { parameters: { screen: { leaderboard: "settling" } } };

/** A new season with no points yet. */
export const NoPointsYet: Story = { parameters: { screen: { leaderboard: "empty" } } };

/** The pool is not switched on yet: "The pool opens with the next upgrade". */
export const OpensWithNextUpgrade: Story = { parameters: { screen: { leaderboard: "upgrade" } } };

export const Loading: Story = { parameters: { screen: { leaderboard: "loading" } } };

export const LoadFailed: Story = { parameters: { screen: { leaderboard: "error" } } };

/** Last season's winners are still waiting to be paid: "Pays <date>" beside prizes, and one rank "not paid". */
export const LastSeasonPaying: Story = { parameters: { screen: { leaderboard: "paying" } } };

/** Nobody won a Match last season: "the pool carried over" instead of a winners table. */
export const LastSeasonPoolCarriedOver: Story = { parameters: { screen: { leaderboard: "carried" } } };

/** The Pool band's ⓘ opened: how the Pool works and the payout scale. */
export const PayoutScaleOpen: Story = {
  parameters: { screen: { leaderboard: "live" } },
  play: async ({ canvasElement }) => {
    const btn = await within(canvasElement).findByRole("button", { name: /How the Pool works/ });
    if (btn.getAttribute("aria-expanded") !== "true") await userEvent.click(btn);
  },
};

/** Signed in with no points this season: the table has no "You" row. */
export const SignedInNotOnTheTable: Story = { parameters: { screen: { leaderboard: "outside" } } };
