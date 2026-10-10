import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { AllMatches } from "@/app/(app)/matches/AllMatches";
import { demoSnapshot } from "@/lib/chain/fixture";

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
