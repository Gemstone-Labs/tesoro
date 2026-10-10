import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { userEvent, waitFor, within } from "storybook/test";
import { PublicKey } from "@solana/web3.js";
import { demoSnapshot } from "@/lib/chain/fixture";
import { ETH_VAULTS } from "@/lib/chain/eth";
import type { AccountSnapshot, ChainPosition } from "@/lib/chain/read";
import Wallet from "@/app/(app)/wallet/page";
import Opening from "@/app/(app)/wallet/opening/page";
import { demoKey, withScreen, type ScreenData } from "./support/screen";
import { withSigner } from "./support/signer";

const meta = {
  title: "Screens/Wallet",
  component: Wallet,
  decorators: [withSigner, withScreen],
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

const ethPosition = (n: number, asset: "ETH" | "HYPE", principal: number, vault: string, paid = false): ChainPosition => ({
  address: new PublicKey(demoKey(900 + n)),
  asset,
  principal,
  apy: asset === "ETH" ? 0.035 : 0.07,
  status: "locked",
  advances: 1,
  advance: { source: new PublicKey(demoKey(950 + n)), gemasIssued: asset === "ETH" ? 6200 : 2400, horizonMonths: 3, debtGemas: asset === "ETH" ? 6200 : 2400 },
  debt: paid ? 0 : asset === "ETH" ? 0.021 : 3.4,
  yieldAccrued: asset === "ETH" ? 0.004 : 0.8,
  native: null,
  eth: { vault, id: BigInt(n) },
});

const ethSnapshot = (paid: boolean) => (a: string): AccountSnapshot => {
  const s = demoSnapshot(a);
  return { ...s, positions: [...s.positions, ethPosition(1, "ETH", 2, ETH_VAULTS[0].address, paid), ethPosition(2, "HYPE", 120, ETH_VAULTS[1].address, paid)] };
};
const withEth = ethSnapshot(false);

/** Positions on Ethereum and HyperEVM show beside the Solana one, each with an open Advance: Debt and an Unlock Estimate. */
export const WithEthAndHypePositions: Story = { parameters: { data: { snapshot: withEth }, screen: { eth: { advance: "open" } } } };

/** The same Positions with the Advance repaid: Debt is zero and Unlock is ready. */
export const EthAndHypePositionsPaidOff: Story = { parameters: { data: { snapshot: ethSnapshot(true) }, screen: { eth: { advance: "paid" } } } };

const openTab = (name: string): Story["play"] => async ({ canvasElement }) => {
  const open = await waitFor(() => within(canvasElement).getAllByRole("button", { name: /Open a Position/ })[0], { timeout: 10_000 });
  await userEvent.click(open);
  const tab = await waitFor(() => within(document.body).getAllByRole("tab", { name: new RegExp(`^${name}`) })[0], { timeout: 10_000 });
  await userEvent.click(tab);
};

/** The Open a Position sheet on the ETH tab. */
export const OpenEthPosition: Story = { parameters: { data: { snapshot: withEth }, screen: { eth: { advance: "open" } } }, play: openTab("ETH") };
export const OpenHypePosition: Story = { parameters: { data: { snapshot: withEth }, screen: { eth: { advance: "open" } } }, play: openTab("HYPE") };

const opening = (step: NonNullable<NonNullable<ScreenData["eth"]>["opening"]>): StoryObj => ({
  render: () => <Opening />,
  decorators: [
    (Story) => {
      try {
        const op = { key: "open-eth-9", kind: "open", vault: ETH_VAULTS[0].address, id: "9", createdAt: Date.now() - 90_000, months: 3, hash: `0x${"ab".repeat(32)}` };
        localStorage.setItem(`tesoro-eth-ops:${PublicKey.default.toBase58()}`, JSON.stringify([op]));
      } catch {}
      return <Story />;
    },
  ],
  parameters: { nextjs: { navigation: { pathname: "/wallet/opening", query: { op: "open-eth-9" } } }, screen: { eth: { opening: step } } },
});

/** `/wallet/opening`: an ETH Position crossing to Solana, one story per step. */
export const OpeningSentOnHoodi = opening("sent");
export const OpeningDeliveredToSolana = opening("delivered");
export const OpeningPositionRecorded = opening("recorded");
export const OpeningGemasArrived = opening("arrived");
export const OpeningFailed = opening("failed");

/** Nothing is opening in this browser. */
export const OpeningNothing: StoryObj = {
  render: () => <Opening />,
  decorators: [
    (Story) => {
      try {
        localStorage.removeItem(`tesoro-eth-ops:${PublicKey.default.toBase58()}`);
      } catch {}
      return <Story />;
    },
  ],
  parameters: { nextjs: { navigation: { pathname: "/wallet/opening" } } },
};
