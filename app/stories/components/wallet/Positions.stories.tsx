import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { userEvent, within } from "storybook/test";
import { EthFaucet, EthOpenForm, EthOps, EthPositionCard } from "@/app/(app)/wallet/EthPositions";
import { NativeAdvanceSheet, NativeExtendSheet, NativeFaucet, NativeOpenForm, NativePositionCard } from "@/app/(app)/wallet/NativePositions";
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
/** Debt is open and the Horizon is under 12 months: Extend sits beside Refresh yield (NEXT_PUBLIC_EXTEND_ADVANCE=1). */
export const SolWithExtend: Story = {
  parameters: { data: { snapshot: nativeSnapshot("debt") } },
  render: () => <NativePositionCard position={nativePosition("debt")} market={NATIVE_MARKET} onRedeem={() => {}} extend />,
};
/** Extend sheet at its default: the slider runs 1 to 12 minus the 3 months already advanced. */
export const SolExtendSheet: Story = {
  parameters: { data: { snapshot: nativeSnapshot("debt") } },
  render: () => <NativeExtendSheet info={nativePosition("debt").native!} market={NATIVE_MARKET} open onClose={() => {}} />,
};
/** Extend sheet with 9 months picked (the most the Horizon allows). */
export const SolExtendSheetMax: Story = {
  ...SolExtendSheet,
  play: async ({ canvasElement }) => {
    const range = within(canvasElement.ownerDocument.body).getByRole("slider");
    await userEvent.type(range, "{End}");
  },
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
