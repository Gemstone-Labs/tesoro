import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Sheet } from "@/components/ui";
import { AckView, DoneView, ErrorView, PacksView, WorkingView, type DepositArt } from "@/components/deposit/DepositPanel";
import { DEPOSIT_PACKS, packMarket, quotePack } from "@/lib/deposit/packs";
import { NATIVE_MARKET } from "../wallet/support";

const quotes = DEPOSIT_PACKS.map((p) => quotePack(p, packMarket(NATIVE_MARKET)!, 0));
const pack = DEPOSIT_PACKS[0];

function Frame({ title = "Get Gemas", children }: { title?: string; children: React.ReactNode }) {
  return (
    <Sheet open onClose={() => {}} title={title} className="dep-sheet">
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
    <PacksView quotes={quotes} highlight={null} art="b" onArt={() => {}} canPay testMode feePct={0} checking={null} onPick={() => {}} {...over} />
  </Frame>
);

/** Three packs, art set B (pouch, case, vault safe). */
export const Packs: Story = { render: () => packs() };
export const ArtSetA: Story = { render: () => packs({ art: "a" as DepositArt }) };
/** A game sent the Player: the pack that covers the entry is marked. */
export const PacksForAGame: Story = { render: () => packs({ highlight: "player" }) };
/** Mainnet before a card provider is connected. */
export const MainnetNoCheckout: Story = { render: () => packs({ canPay: false, testMode: false }) };
export const PriceNotReady: Story = { render: () => packs({ quotes: null }) };

export const Acknowledgment: Story = {
  render: () => (
    <Frame title="Before you deposit">
      <AckView pack={pack} checked={false} onChecked={() => {}} busy={false} error={null} onConfirm={() => {}} onBack={() => {}} />
    </Frame>
  ),
};
export const Paying: Story = {
  render: () => (
    <Frame>
      <WorkingView pack={pack} phase="paying" testMode hours={2} />
    </Frame>
  ),
};
export const Adding: Story = {
  render: () => (
    <Frame>
      <WorkingView pack={pack} phase="adding" testMode hours={2} />
    </Frame>
  ),
};
export const Success: Story = {
  render: () => (
    <Frame>
      <DoneView gemas={560} back={null} onDone={() => {}} testMode hours={2} />
    </Frame>
  ),
};
export const SuccessFromAGame: Story = {
  render: () => (
    <Frame>
      <DoneView gemas={1400} back={{ href: "/play/queue?game=holdem&entry=500", label: "Play Buckshot Hold'em", need: 500 }} onDone={() => {}} testMode hours={2} />
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
