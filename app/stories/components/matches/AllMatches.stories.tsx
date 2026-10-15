import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { AllMatches } from "@/app/(app)/matches/AllMatches";
import { demoSnapshot } from "@/lib/chain/fixture";
import { chainMatch } from "../../screens/support/matches";

const meta = {
  title: "Components/matches/AllMatches",
  component: AllMatches,
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/matches" } } },
} satisfies Meta<typeof AllMatches>;
export default meta;
type Story = StoryObj<typeof meta>;

export const FirstPage: Story = {};
export const SecondPage: Story = { parameters: { nextjs: { navigation: { pathname: "/matches", query: { page: "2" } } } } };
export const OnlyBlockPuzzle: Story = { parameters: { nextjs: { navigation: { pathname: "/matches", query: { game: "block-puzzle" } } } } };
export const NoMatches: Story = { parameters: { data: { snapshot: (a: string) => ({ ...demoSnapshot(a), matches: [], funded: [] }) } } };
export const Loading: Story = { parameters: { data: { snapshot: null } } };
export const LoadFailed: Story = { parameters: { data: { snapshotError: "Loading your Account took too long." } } };
export const SignedOut: Story = { parameters: { auth: "signed-out" } };

const secs = () => Math.floor(Date.now() / 1000);
/** Matches past their settle time sit above the finished ones: "Delayed, refunds by ...". */
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
export const WithDelayed1440: Story = { ...WithDelayed, globals: { viewport: { value: "desktop1440", isRotated: false } } };
export const WithDelayed390: Story = { ...WithDelayed, globals: { viewport: { value: "phone390", isRotated: false } } };
