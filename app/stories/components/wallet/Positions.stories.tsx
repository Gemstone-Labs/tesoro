import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { userEvent, within } from "storybook/test";
import { EthFaucet, EthOpenForm, EthOps, EthPositionCard } from "@/app/(app)/wallet/EthPositions";
import { NativeAdvanceSheet, NativeFaucet, NativeOpenForm, NativePositionCard } from "@/app/(app)/wallet/NativePositions";
import { ETH_VAULTS } from "@/lib/chain/eth";
import { withScreen } from "../../screens/support/screen";
import { withSigner } from "../../screens/support/signer";
import { NATIVE_MARKET, ethPosition, ethSnapshot, nativePosition, nativeSnapshot, saveOpenOp } from "./support";

const meta = {
  title: "Components/wallet/Positions",
  decorators: [withSigner, withScreen, (Story) => <div style={{ maxWidth: 440 }}><Story /></div>],
  parameters: { screen: { eth: { advance: "open" } } },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

/** A SOL Position with half its Debt repaid by yield. */
export const SolWithDebt: Story = {
  parameters: { data: { snapshot: nativeSnapshot("debt") } },
  render: () => <NativePositionCard position={nativePosition("debt")} market={NATIVE_MARKET} onRedeem={() => {}} />,
};
/** The card's small print says Tesoro keeps 20% of the yield (the Yield Fee). */
export const SolYieldFeeNote: Story = {
  ...SolWithDebt,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByText("Details"));
  },
};
/** No Treasury on chain yet: quotes use the launch Yield Fee (20%). */
export const SolOpenFormNoTreasury: Story = {
  parameters: { data: { snapshot: nativeSnapshot() } },
  render: () => <NativeOpenForm market={{ ...NATIVE_MARKET, treasury: null, treasuryShares: null }} loading={false} />,
};
export const SolRepaid: Story = {
  parameters: { data: { snapshot: nativeSnapshot("repaid") } },
  render: () => <NativePositionCard position={nativePosition("repaid")} market={NATIVE_MARKET} onRedeem={() => {}} />,
};
/** Debt is zero: Take another Advance on the same Principal, or Unlock. */
export const SolTakeAnotherAdvance: Story = {
  parameters: { data: { snapshot: nativeSnapshot("repaid") } },
  render: () => <NativeAdvanceSheet info={nativePosition("repaid").native!} market={NATIVE_MARKET} open onClose={() => {}} />,
};
export const SolUnlocked: Story = {
  parameters: { data: { snapshot: nativeSnapshot("unlocked") } },
  render: () => <NativePositionCard position={nativePosition("unlocked")} market={NATIVE_MARKET} onRedeem={() => {}} />,
};
export const SolOpenForm: Story = {
  parameters: { data: { snapshot: nativeSnapshot() } },
  render: () => <NativeOpenForm market={NATIVE_MARKET} loading={false} />,
};
export const SolFaucet: Story = { render: () => <NativeFaucet market={NATIVE_MARKET} loading={false} /> };

export const EthWithAdvance: Story = {
  parameters: { data: { snapshot: ethSnapshot() } },
  render: () => <EthPositionCard position={ethPosition(1, "ETH")} market={null} />,
};
export const EthAdvancePaid: Story = {
  parameters: { data: { snapshot: ethSnapshot(true) }, screen: { eth: { advance: "paid" } } },
  render: () => <EthPositionCard position={ethPosition(1, "ETH", true)} market={null} />,
};
export const HypeWithAdvance: Story = {
  parameters: { data: { snapshot: ethSnapshot() } },
  render: () => <EthPositionCard position={ethPosition(2, "HYPE")} market={null} />,
};
export const EthOpenFormStory: Story = { name: "Eth open form", render: () => <EthOpenForm vault={ETH_VAULTS[0]} onOpened={() => {}} /> };
export const HypeOpenForm: Story = { render: () => <EthOpenForm vault={ETH_VAULTS[1]} onOpened={() => {}} /> };
export const EthFaucetStory: Story = { name: "Eth faucet", render: () => <EthFaucet vault={ETH_VAULTS[0]} /> };

/** Cross-chain Positions that are opening, tracked beside the cards. */
export const OpeningTracker: Story = {
  decorators: [(Story) => (saveOpenOp(), <Story />)],
  parameters: { data: { snapshot: ethSnapshot() }, screen: { eth: { opening: "delivered" } } },
  render: () => <EthOps />,
};
