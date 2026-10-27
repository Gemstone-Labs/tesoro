import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { PublicKey } from "@solana/web3.js";
import { userEvent, within } from "storybook/test";
import { RedeemExchange, RedeemSheet, ReturnOwnSheet, ReturnSheet, type InstantOffer } from "@/app/(app)/wallet/MoneySheets";
import { NativeRedeemSheet } from "@/app/(app)/wallet/NativePositions";
import { demoSnapshot } from "@/lib/chain/fixture";
import { ETH_VAULTS } from "@/lib/chain/eth";
import type { AccountSnapshot, ChainHolding } from "@/lib/chain/read";
import { positions } from "@/lib/mock";
import { demoKey, withScreen } from "../../screens/support/screen";
import { withSigner } from "../../screens/support/signer";
import { nativePosition, nativeSnapshot } from "./support";

const meta = {
  title: "Components/wallet/MoneySheets",
  component: RedeemSheet,
  args: { open: true, onClose: () => {} },
  argTypes: { onClose: { control: false } },
} satisfies Meta<typeof RedeemSheet>;
export default meta;
type Story = StoryObj<typeof meta>;

/** Redeem on the demo Account's Gemas: each one redeems for its Source asset, as far as that Source has accrued. */
export const Redeem: Story = {};

export const RedeemNothing: Story = {
  parameters: { data: { snapshot: (a: string) => ({ ...demoSnapshot(a), holdings: [] }) } },
};

/** Redeem on chain from your SOL Lock alone. */
export const RedeemOnChain: Story = {
  decorators: [withSigner],
  parameters: { data: { snapshot: nativeSnapshot("debt") } },
  render: (args) => <NativeRedeemSheet {...args} />,
};

export const ReturnUnspent: Story = {
  render: () => <ReturnSheet position={positions[0]} onClose={() => {}} />,
};

const pk = (n: number) => new PublicKey(demoKey(n));

/** Four Locks: your SOL Lock, SOL won from another Player, your ETH Lock (ETH at $3,000), HYPE won. */
const redeemSnapshot = (a: string): AccountSnapshot => {
  const s = nativeSnapshot("debt")(a);
  const own = s.holdings[0];
  const won: ChainHolding = { ...own, key: "line-211", source: pk(311), position: pk(411), isOwn: false, sourceOwner: pk(511).toBase58(), amount: 860n, free: 860n, redeemable: 860n };
  const eth: ChainHolding = { ...own, key: "line-212", source: pk(312), position: pk(412), native: false, asset: "ETH", eth: { vault: ETH_VAULTS[0].address, id: 1n }, unitNum: 10n ** 22n, unitDen: 3_000_000_000n, amount: 620n, free: 620n, redeemable: 620n };
  const hype: ChainHolding = { ...eth, key: "line-213", source: pk(313), position: pk(413), isOwn: false, sourceOwner: pk(513).toBase58(), asset: "HYPE", eth: { vault: ETH_VAULTS[1].address, id: 2n }, unitDen: 40_000_000n, amount: 400n, free: 400n, redeemable: 400n };
  return { ...s, holdings: [own, won, eth, hype] };
};

/** Your SOL Position with 5,500 Gemas of Debt left on its Advance and 3,500 of your own Gemas unspent (and, with `two`, a second Advance). */
const returnSnapshot = (two: boolean) => (a: string): AccountSnapshot => {
  const s = nativeSnapshot("debt")(a);
  const first: ChainHolding = { ...s.holdings[0], source: s.positions[0].native!.source!.key, isOwn: true, sourceOwner: s.accountKey.toBase58(), sourceDebt: 5500n, amount: 3500n, free: 3500n };
  const second: ChainHolding = { ...first, key: "line-221", source: pk(321), sourceDebt: 2000n, amount: 1500n, free: 1500n };
  return { ...s, holdings: two ? [first, second, s.holdings[1]] : [first, s.holdings[1]] };
};

/** Redeem on chain from four Sources: test SOL now, ETH and HYPE on their own chains a few minutes later. */
export const RedeemFourSources: Story = {
  decorators: [withSigner],
  parameters: { data: { snapshot: redeemSnapshot } },
  render: (args) => <NativeRedeemSheet {...args} />,
};

export const ReturnOnChain: Story = {
  decorators: [withSigner],
  parameters: { data: { snapshot: returnSnapshot(false) } },
  render: () => <ReturnOwnSheet position={nativePosition("debt")} open onClose={() => {}} />,
};

/** Two Advances on one Position: pick which Debt the Gemas cancel. */
export const ReturnTwoAdvances: Story = {
  decorators: [withSigner],
  parameters: { data: { snapshot: returnSnapshot(true) } },
  render: () => <ReturnOwnSheet position={nativePosition("debt")} open onClose={() => {}} />,
};

export const ReturnNothing: Story = {
  decorators: [withSigner],
  parameters: { data: { snapshot: nativeSnapshot("debt") } },
  render: () => <ReturnOwnSheet position={nativePosition("debt")} open onClose={() => {}} />,
};

/** Opens the "Redeem now" side of the sheet (it renders in a portal). */
const openRedeemNow = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole("radio", { name: /Redeem now/ }));
};

const onlySol = (a: string): AccountSnapshot => {
  const s = redeemSnapshot(a);
  return { ...s, holdings: s.holdings.slice(0, 2) };
};
const onlyEth = (a: string): AccountSnapshot => {
  const s = redeemSnapshot(a);
  return { ...s, holdings: [s.holdings[2], s.holdings[3]] };
};
const withMarket = (snapshot: (a: string) => AccountSnapshot, market: Partial<NonNullable<AccountSnapshot["market"]>>) => (a: string): AccountSnapshot => {
  const s = snapshot(a);
  return { ...s, market: { ...s.market!, ...market } };
};

/** Won and own SOL Gemas sold now: 60% of their value in test SOL in the same transaction, the 25% Tesoro keeps said plainly, and the most the treasury can pay. */
export const RedeemNowSol: Story = {
  decorators: [withSigner],
  parameters: { data: { snapshot: onlySol } },
  render: (args) => <NativeRedeemSheet {...args} />,
  play: openRedeemNow,
};

/** Won SOL and HYPE Gemas and an ETH Position's Gemas: ETH and HYPE are paid on their own chains a few minutes later. */
export const RedeemNowEthAndHype: Story = {
  decorators: [withSigner, withScreen],
  parameters: { data: { snapshot: redeemSnapshot }, screen: { vaultTreasury: "ready" } },
  render: (args) => <NativeRedeemSheet {...args} />,
  play: openRedeemNow,
};

/** The Solana treasury holds only 0.00005 simSOL: Redeem now sells as many Gemas as it can pay and no more. */
export const RedeemNowTreasuryShort: Story = {
  decorators: [withSigner],
  parameters: { data: { snapshot: withMarket(onlySol, { treasuryShares: 50_000n }) } },
  render: (args) => <NativeRedeemSheet {...args} />,
  play: openRedeemNow,
};

/** The Solana treasury holds nothing: "Instant Redeem unavailable right now" with the plain way out, instead of an offer or an error. */
export const RedeemNowTreasuryEmpty: Story = {
  decorators: [withSigner],
  parameters: { data: { snapshot: withMarket(onlySol, { treasuryShares: 0n }) } },
  render: (args) => <NativeRedeemSheet {...args} />,
  play: openRedeemNow,
};

/** Before the Treasury exists on chain: the plain reason instead of an offer. */
export const RedeemNowNotSetUp: Story = {
  decorators: [withSigner],
  parameters: { data: { snapshot: withMarket(onlySol, { treasury: null, treasuryShares: null }) } },
  render: (args) => <NativeRedeemSheet {...args} />,
  play: openRedeemNow,
};

/** ETH and HYPE vaults that have no treasury mirror (old vaults): nothing can be paid on them. */
export const RedeemNowOldVaults: Story = {
  decorators: [withSigner, withScreen],
  parameters: { data: { snapshot: onlyEth }, screen: { vaultTreasury: "none" } },
  render: (args) => <NativeRedeemSheet {...args} />,
  play: openRedeemNow,
};

/** The EVM vault treasuries are nearly empty. */
export const RedeemNowEvmTreasuryShort: Story = {
  decorators: [withSigner, withScreen],
  parameters: { data: { snapshot: onlyEth }, screen: { vaultTreasury: "short" } },
  render: (args) => <NativeRedeemSheet {...args} />,
  play: openRedeemNow,
};

const offer = (orders: NonNullable<InstantOffer["orders"]>): InstantOffer => ({
  rows: [
    { key: "a", asset: "SOL", from: "Won · 7zr1…qh7M", gemas: 1500, amount: 0.075, token: "test SOL", later: false, yieldFeeBps: 2000 },
    { key: "b", asset: "SOL", from: "Your SOL deposit", gemas: 1000, amount: 0.05, token: "test SOL", later: false, yieldFeeBps: 2000 },
  ],
  feePct: 25,
  yieldFeePct: 20,
  available: [{ asset: "SOL", amount: 2.4, token: "test SOL" }],
  unavailable: null,
  orders,
});
const exchange = (instant: InstantOffer, done: Parameters<typeof RedeemExchange>[0]["done"] = null) => (
  <div style={{ maxWidth: 480, margin: "24px auto", padding: "0 16px" }}>
    <RedeemExchange payouts={[]} instant={instant} busy={false} error={null} done={done} canSign onRedeem={() => {}} onInstant={() => {}} onCancelOrder={() => {}} onClose={() => {}} />
  </div>
);

/** Instant Redeem is a request: the Player offers the Gemas, Tesoro buys when it can. Here one request is already waiting. */
export const InstantRedeemRequested: Story = {
  render: () => exchange(offer([{ key: "o1", gemas: 1200, sold: 0, expiresAt: Date.now() + 6 * 86_400_000, state: "requested" }])),
  play: openRedeemNow,
};
/** A request Tesoro has bought part of. */
export const InstantRedeemPartlyBought: Story = {
  render: () => exchange(offer([{ key: "o1", gemas: 800, sold: 400, expiresAt: Date.now() + 2 * 86_400_000, state: "partly-sold" }])),
  play: openRedeemNow,
};
/** Right after the request was sent. */
export const InstantRedeemSent: Story = {
  render: () => exchange(offer([]), { gemas: 1500, later: false, instant: true }),
};

const redeemRows = [
  { key: "a", asset: "SOL" as const, from: "Your SOL Lock", gemas: 1200, amount: 0.06, token: "test SOL", later: false, yieldFeeBps: 2000 },
  { key: "b", asset: "SOL" as const, from: "Won · 7zr1…qh7M", gemas: 800, amount: 0.04, token: "test SOL", later: false, yieldFeeBps: 2000 },
];
const picker = (instant: InstantOffer | null = null) => (
  <div style={{ maxWidth: 480, margin: "24px auto", padding: "0 16px" }}>
    <RedeemExchange payouts={redeemRows} instant={instant} busy={false} error={null} done={null} canSign onRedeem={() => {}} onInstant={() => {}} onClose={() => {}} />
  </div>
);

/** Choose how many Gemas to Redeem: the rows and the payout follow the number, whole lines first. */
export const RedeemPickAmount: Story = {
  render: () => picker(),
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole("button", { name: "50%" }));
    await body.findByText(/after the 20% Yield Fee/);
  },
};

/** The same pick on the Redeem now side, with an own-Gemas line in the offer. */
export const RedeemNowPickAmount: Story = {
  render: () => picker(offer([])),
  play: async (ctx) => {
    await openRedeemNow(ctx);
    const body = within(ctx.canvasElement.ownerDocument.body);
    await userEvent.click(await body.findByRole("button", { name: "50%" }));
    await body.findByText(/Yield Fee and 25% fee/);
  },
};
