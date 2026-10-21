import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Sheet } from "@/components/ui";
import { AckView, DoneView, ErrorView, PacksView, WorkingView } from "@/components/deposit/DepositPanel";
import type { DepositStep } from "@/components/deposit/use-deposit-flow";
import { DEPOSIT_PACKS, packMarket, quotePack } from "@/lib/deposit/packs";
import { NATIVE_MARKET } from "../wallet/support";

const quotes = DEPOSIT_PACKS.map((p) => quotePack(p, packMarket(NATIVE_MARKET)!, 0));
const pack = DEPOSIT_PACKS[1];

function Frame({ title = "Get Gemas", step = "packs", children }: { title?: string; step?: DepositStep; children: React.ReactNode }) {
  return (
    <Sheet open onClose={() => {}} title={title} className={`dep-sheet ${step}`}>
      {children}
    </Sheet>
  );
}

const meta = {
  title: "Components/deposit/DepositSheet",
  parameters: { layout: "fullscreen" },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const packs = (over: Partial<React.ComponentProps<typeof PacksView>> = {}) => (
  <Frame>
    <PacksView quotes={quotes} highlight={null} canPay testMode feePct={0} onPick={() => {}} {...over} />
  </Frame>
);

/** Three packs: the Player pack in the middle, bigger, tagged Most picked. */
export const Packs: Story = { render: () => packs() };
/** A game sent the Player: the pack that covers the entry is marked. */
export const PacksForAGame: Story = { render: () => packs({ highlight: "starter" }) };
/** Mainnet with a card provider: the third note names the ways to pay. */
export const PacksMainnet: Story = { render: () => packs({ testMode: false }) };
/** Mainnet before a card provider is connected. */
export const MainnetNoCheckout: Story = { render: () => packs({ canPay: false, testMode: false }) };
export const PriceNotReady: Story = { render: () => packs({ quotes: null }) };

export const Acknowledgment: Story = {
  render: () => (
    <Frame title="Before you deposit" step="ack">
      <AckView dontShow={false} onDontShow={() => {}} busy={false} error={null} onConfirm={() => {}} />
    </Frame>
  ),
};
export const AcknowledgmentFailed: Story = {
  render: () => (
    <Frame title="Before you deposit" step="ack">
      <AckView dontShow onDontShow={() => {}} busy={false} error="That didn’t go through. Try again in a moment." onConfirm={() => {}} />
    </Frame>
  ),
};
export const Paying: Story = {
  render: () => (
    <Frame>
      <WorkingView pack={DEPOSIT_PACKS[0]} phase="paying" testMode hours={2} />
    </Frame>
  ),
};
export const Adding: Story = {
  render: () => (
    <Frame>
      <WorkingView pack={DEPOSIT_PACKS[0]} phase="adding" testMode hours={2} />
    </Frame>
  ),
};
export const Success: Story = {
  render: () => (
    <Frame title="Your Gemas are ready" step="done">
      <DoneView gemas={1400} packId="player" back={null} onDone={() => {}} testMode hours={2} />
    </Frame>
  ),
};
export const SuccessFromAGame: Story = {
  render: () => (
    <Frame title="Your Gemas are ready" step="done">
      <DoneView gemas={1400} packId="player" back={{ href: "/play/queue?game=holdem&entry=500", label: "Play Buckshot Hold'em", need: 500 }} onDone={() => {}} testMode hours={2} />
    </Frame>
  ),
};
export const ErrorState: Story = {
  render: () => (
    <Frame>
      <ErrorView pack={pack} message="The network is busy right now. Wait a few seconds and try again." paidAlready onRetry={() => {}} onClose={() => {}} />
    </Frame>
  ),
};
