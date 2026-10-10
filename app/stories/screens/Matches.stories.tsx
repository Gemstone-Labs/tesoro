import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { demoSnapshot } from "@/lib/chain/fixture";
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
