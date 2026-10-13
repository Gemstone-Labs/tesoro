import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { PublicKey } from "@solana/web3.js";
import { BackPlayerRail } from "@/components/lobby/BackPlayerRail";
import { demoBoard } from "@/lib/chain/fixture";
import { lobbyDecorators } from "./support";

const meta = {
  title: "Components/lobby/BackPlayerRail",
  component: BackPlayerRail,
  decorators: lobbyDecorators,
  parameters: { layout: "fullscreen", shell: "app" },
} satisfies Meta<typeof BackPlayerRail>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The Backing explainer, then live Requests strongest record first: record, P&L and Back for. One Player is behind, one is new. */
export const Default: Story = {};
export const NoRequests: Story = { parameters: { data: { board: { requests: [], offers: [], fetchedAt: 0 } } } };
export const Loading: Story = { parameters: { screen: { board: "loading" } } };
export const LoadFailed: Story = { parameters: { screen: { board: "error" } } };

const dupes = demoBoard();
dupes.requests.push(
  { ...dupes.requests[0], address: PublicKey.unique(), expiresAt: dupes.requests[0].expiresAt + 3600, entry: 500 },
  { ...dupes.requests[2], address: PublicKey.unique(), expiresAt: dupes.requests[2].expiresAt - 60, game: "holdem" },
);
/** A Player with several live Requests shows once, with the one that expires soonest. */
export const DuplicateRequests: Story = { parameters: { data: { board: dupes } } };
