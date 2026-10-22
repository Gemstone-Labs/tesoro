import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ReviewView } from "@/components/admin/ReviewView";
import type { ReviewReply } from "@/lib/review/flags";

const A = "7zr1j185aLmHqYk3gT9u2WpXcVbN4dEfRs6JqhM1qh7M";
const B = "GXQse6RGq2nYtUwB8cJk5pLvHdZfX3aMrN9sT4eWrMGK";
const C = "G7zDx4Kp9QwLm2VnYbT6uJc8HsRfE3aZoNqXd5iWcTYP";

const review: ReviewReply = {
  now: 1_792_000_000,
  seasons: [
    { number: 2, phase: "current" },
    { number: 1, phase: "payout-window", windowEnds: 1_792_100_000 },
  ],
  flags: [
    { kind: "timing", season: 2, account: A, summary: "3 Block Burst runs look scripted: 3 too fast for a person (under 300 ms a move).", matchIds: ["101", "102", "107"] },
    { kind: "pair", season: 2, account: B, other: C, summary: "Met 11 times this Season: 10 won by this Account, 1 by the other. Lopsided.", matchIds: Array.from({ length: 11 }, (_, i) => String(200 + i)) },
    { kind: "win-rate", season: 1, account: C, summary: "Won 18 of 22 decided Matches (82%).", matchIds: Array.from({ length: 18 }, (_, i) => String(300 + i)) },
  ],
};

const meta = {
  title: "Screens/Review",
  component: ReviewView,
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/admin/review" } } },
} satisfies Meta<typeof ReviewView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Flags: Story = { args: { review } };
export const Nothing: Story = { args: { review: { ...review, flags: [] } } };
export const Loading: Story = { args: { review: null } };
export const SignedOut: Story = { args: { review: null, signedOut: true } };
export const NotAllowed: Story = { args: { review: null, error: "This wallet is not on the review list." } };
