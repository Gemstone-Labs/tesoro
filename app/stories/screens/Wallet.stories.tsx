import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { demoSnapshot } from "@/lib/chain/fixture";
import Wallet from "@/app/(app)/wallet/page";

const meta = {
  title: "Screens/Wallet",
  component: Wallet,
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/wallet" } } },
} satisfies Meta<typeof Wallet>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The demo Account: one SOL Position with an Advance, Gemas from two Sources. */
export const WithPositions: Story = {};

export const NoPositions: Story = {
  parameters: { data: { snapshot: (a: string) => ({ ...demoSnapshot(a), positions: [], holdings: [], ownTotal: 0n, wonTotal: 0n }) } },
};

export const NoAccountYet: Story = {
  parameters: { data: { snapshot: (a: string) => ({ ...demoSnapshot(a), exists: false, positions: [], holdings: [], matches: [], funded: [], ownTotal: 0n, wonTotal: 0n }) } },
};

export const Loading: Story = { parameters: { data: { snapshot: null } } };

export const LoadFailed: Story = { parameters: { data: { snapshotError: "Loading your Account took too long." } } };

export const SignedOut: Story = { parameters: { auth: "signed-out" } };
