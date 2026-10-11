import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { PublicKey } from "@solana/web3.js";
import { RedeemSheet, ReturnOwnSheet, ReturnSheet } from "@/app/(app)/wallet/MoneySheets";
import { NativeRedeemSheet } from "@/app/(app)/wallet/NativePositions";
import { demoSnapshot } from "@/lib/chain/fixture";
import { ETH_VAULTS } from "@/lib/chain/eth";
import type { AccountSnapshot, ChainHolding } from "@/lib/chain/read";
import { positions } from "@/lib/mock";
import { demoKey } from "../../screens/support/screen";
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

/** Redeem on chain from your SOL Position alone. */
export const RedeemOnChain: Story = {
  decorators: [withSigner],
  parameters: { data: { snapshot: nativeSnapshot("debt") } },
  render: (args) => <NativeRedeemSheet {...args} />,
};

export const ReturnUnspent: Story = {
  render: () => <ReturnSheet position={positions[0]} onClose={() => {}} />,
};

const pk = (n: number) => new PublicKey(demoKey(n));

/** Four Sources: your SOL Position, SOL won from another Player, your ETH Position (ETH at $3,000), HYPE won. */
const redeemSnapshot = (a: string): AccountSnapshot => {
  const s = nativeSnapshot("debt")(a);
  const own = s.holdings[0];
  const won: ChainHolding = { ...own, holding: pk(211), source: pk(311), position: pk(411), isOwn: false, sourceOwner: pk(511).toBase58(), amount: 860n, free: 860n, redeemable: 860n };
  const eth: ChainHolding = { ...own, holding: pk(212), source: pk(312), position: pk(412), native: false, asset: "ETH", eth: { vault: ETH_VAULTS[0].address, id: 1n }, unitNum: 10n ** 22n, unitDen: 3_000_000_000n, amount: 620n, free: 620n, redeemable: 620n };
  const hype: ChainHolding = { ...eth, holding: pk(213), source: pk(313), position: pk(413), isOwn: false, sourceOwner: pk(513).toBase58(), asset: "HYPE", eth: { vault: ETH_VAULTS[1].address, id: 2n }, unitDen: 40_000_000n, amount: 400n, free: 400n, redeemable: 400n };
  return { ...s, holdings: [own, won, eth, hype] };
};

/** Your SOL Position with 5,500 Gemas of Debt left on its Advance and 3,500 of your own Gemas unspent (and, with `two`, a second Advance). */
const returnSnapshot = (two: boolean) => (a: string): AccountSnapshot => {
  const s = nativeSnapshot("debt")(a);
  const first: ChainHolding = { ...s.holdings[0], source: s.positions[0].native!.source!.key, isOwn: true, sourceOwner: s.accountKey.toBase58(), sourceDebt: 5500n, amount: 3500n, free: 3500n };
  const second: ChainHolding = { ...first, holding: pk(221), source: pk(321), sourceDebt: 2000n, amount: 1500n, free: 1500n };
  return { ...s, holdings: two ? [first, second, s.holdings[1]] : [first, s.holdings[1]] };
};

/** Redeem on chain from four Sources: simSOL now, ETH and HYPE on their own chains a few minutes later. */
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
