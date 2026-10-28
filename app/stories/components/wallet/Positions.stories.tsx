import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { userEvent, within } from "storybook/test";
import { EthFaucet, EthOpenForm, EthOps, EthPositionCard } from "@/app/(app)/wallet/EthPositions";
import { NativeAdvanceSheet, NativeExtendSheet, NativeFaucet, NativeOpenForm, NativePositionCard } from "@/app/(app)/wallet/NativePositions";
import { DEFAULT_EXTEND_LIMIT_DATA, type ExtendLimitData } from "@/lib/chain/extend-limit";
import { quoteNativeAdvance } from "@/lib/chain/native";
import { JITOSOL } from "@/lib/chain/stake";
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
  render: () => <NativePositionCard position={nativePosition("debt")} market={NATIVE_MARKET} />,
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
  render: () => <NativePositionCard position={nativePosition("repaid")} market={NATIVE_MARKET} />,
};
/** A 3-month Advance as the program sized it (the shared fixture's issued count is arbitrary), so Extend quotes the real difference. */
const extendable = () => {
  const info = nativePosition("debt").native!;
  const issued = quoteNativeAdvance(info.principalLamports, info.rateBps, 3, info.source!.math.unitDen).gemas;
  return { ...info, source: { ...info.source!, math: { ...info.source!.math, issued, returned: issued / 2n } } };
};
/** Debt is open and the Horizon is under 12 months: Extend sits beside Refresh yield (NEXT_PUBLIC_EXTEND_ADVANCE=1). */
export const SolWithExtend: Story = {
  parameters: { data: { snapshot: nativeSnapshot("debt") } },
  render: () => <NativePositionCard position={nativePosition("debt")} market={NATIVE_MARKET} extend />,
};
/** Extend sheet at its default: the slider runs 1 to 12 minus the 3 months already advanced. */
export const SolExtendSheet: Story = {
  parameters: { data: { snapshot: nativeSnapshot("debt") } },
  render: () => <NativeExtendSheet info={extendable()} market={NATIVE_MARKET} open onClose={() => {}} />,
};
/** Extend sheet with 9 months picked (the most the Horizon allows). */
export const SolExtendSheetMax: Story = {
  ...SolExtendSheet,
  play: async ({ canvasElement }) => {
    const range = await within(canvasElement.ownerDocument.body).findByRole("slider");
    range.focus();
    await userEvent.keyboard("{End}");
  },
};
const HOUR = 3600;
const sec = () => Math.floor(Date.now() / 1000);
/** An Extend Limit read as the program holds it, relative to now: `ago` seconds since the first Extend of the period. */
const limitWith = (l: Partial<ExtendLimitData> & { ago?: number; lastAgo?: number }): ExtendLimitData => {
  const { ago, lastAgo, ...rest } = l;
  return {
    ...DEFAULT_EXTEND_LIMIT_DATA,
    ...(ago !== undefined ? { windowStart: sec() - ago } : {}),
    ...(lastAgo !== undefined ? { lastExtendAt: sec() - lastAgo } : {}),
    ...rest,
  };
};
const extendSheet = (limit: ExtendLimitData | "unknown") => ({
  parameters: { data: { snapshot: nativeSnapshot("debt") } },
  render: () => <NativeExtendSheet info={extendable()} market={NATIVE_MARKET} open onClose={() => {}} limit={limit} />,
});
/** No Extend yet: the default limit of 3 months a period, nothing used, the picker stops at 3. */
export const SolExtendCanExtend: Story = extendSheet(DEFAULT_EXTEND_LIMIT_DATA);
/** One month extended 2 hours ago: the button waits and says until when. */
export const SolExtendWaiting: Story = extendSheet(limitWith({ windowMonths: 1, ago: 2 * HOUR, lastAgo: 2 * HOUR }));
/** The 3 months are used: the button says when the 30-day period resets. */
export const SolExtendAtLimit: Story = extendSheet(limitWith({ windowMonths: 3, ago: 5 * 24 * HOUR, lastAgo: 5 * 24 * HOUR }));
/** Limit set to 0: Extend is off until the Player raises it (24 h). */
export const SolExtendLimitZero: Story = extendSheet(limitWith({ months: 0 }));
/** The Extend Limit could not be read: Extend is off with a retry line, not offered at the default. */
export const SolExtendLimitUnknown: Story = extendSheet("unknown");
/** A raise to 6 months is waiting for its 24 h. */
export const SolExtendPendingRaise: Story = extendSheet(limitWith({ pendingMonths: 6, pendingAt: sec() + 20 * HOUR }));

/** Debt is zero: Take another Advance on the same Principal, or Unlock. */
export const SolTakeAnotherAdvance: Story = {
  parameters: { data: { snapshot: nativeSnapshot("repaid") } },
  render: () => <NativeAdvanceSheet info={nativePosition("repaid").native!} market={NATIVE_MARKET} open onClose={() => {}} />,
};
/** A staking-token Lock: 12 SOL locked at rate 1.20 (jitoSOL), Debt paid. */
function stakePosition(state: "repaid" | "unlocked") {
  const base = nativePosition(state);
  return {
    ...base,
    native: { ...base.native!, mint: JITOSOL.mint, stakeRateOpen: 1_200_000_000_000n, principalLamports: 12_000_000_000n, custodyShares: 9_090_909_092n },
  };
}
/** Debt is zero and the rate fell after the yield was paid: Unlock says how much it will be short, before it is pressed. */
export const SolUnlockShortfall: Story = {
  parameters: { data: { snapshot: nativeSnapshot("repaid") } },
  render: () => <NativePositionCard position={stakePosition("repaid")} market={NATIVE_MARKET} shortfall={{ before: 636_363_635n }} />,
};
/** Same Lock, rate unchanged: no notice. */
export const SolUnlockInFull: Story = {
  parameters: { data: { snapshot: nativeSnapshot("repaid") } },
  render: () => <NativePositionCard position={stakePosition("repaid")} market={NATIVE_MARKET} shortfall={{}} />,
};
/** After Unlock: the receipt keeps the amount that came back short. */
export const SolUnlockedShortfallReceipt: Story = {
  parameters: { data: { snapshot: nativeSnapshot("unlocked") } },
  render: () => <NativePositionCard position={stakePosition("unlocked")} market={NATIVE_MARKET} shortfall={{ receipt: 636_363_635n }} />,
};
export const SolUnlocked: Story = {
  parameters: { data: { snapshot: nativeSnapshot("unlocked") } },
  render: () => <NativePositionCard position={nativePosition("unlocked")} market={NATIVE_MARKET} />,
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
