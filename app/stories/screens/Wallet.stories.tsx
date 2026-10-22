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
import { nativeSnapshot } from "../components/wallet/support";

const meta = {
  title: "Screens/Wallet",
  component: Wallet,
  decorators: [withSigner, withScreen],
  parameters: { layout: "fullscreen", shell: "app", nextjs: { navigation: { pathname: "/wallet" } } },
} satisfies Meta<typeof Wallet>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The demo Account: one SOL Lock with an Advance, Gemas from two Players. */
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

/** Some Gemas are held back for open Backing Offers: the "reserved for your Backing Offers" note sits above the cards. */
export const GemasReservedForOffers: Story = {
  parameters: {
    data: {
      snapshot: (a: string): AccountSnapshot => {
        const s = demoSnapshot(a);
        return { ...s, holdings: s.holdings.map((h, i) => (i === 0 ? { ...h, reserved: 1200n, free: h.amount - 1200n } : h)) };
      },
    },
  },
};

/** Sent here by a game that needs 2,500 Gemas (`?open=1&game=holdem&need=2500`): the Get Gemas sheet opens with that context. */
export const FromNotEnoughGemas: Story = { parameters: { screen: { search: "open=1&game=holdem&need=2500" } } };

/** The Get Gemas sheet on its first tab, SOL. */
export const OpenSolPosition: Story = {
  play: async ({ canvasElement }) => {
    const open = await waitFor(() => within(canvasElement).getAllByRole("button", { name: /Get Gemas/ })[0], { timeout: 10_000 });
    await userEvent.click(open);
  },
};

/** A Lock held natively on Solana: the SOL card shows the Lock with its Advance, Debt and Unlock Estimate. */
export const NativeSolLock: Story = { parameters: { data: { snapshot: nativeSnapshot("debt") } } };

/** Only Solana Gemas, none redeemable yet: the Redeem button is off and says "Nothing redeemable yet". */
export const NothingRedeemableYet: Story = {
  parameters: {
    data: {
      snapshot: (a: string): AccountSnapshot => {
        const s = demoSnapshot(a);
        const holdings = s.holdings.filter((h) => h.asset === "SOL").map((h) => ({ ...h, redeemable: 0n }));
        return { ...s, holdings, ownTotal: holdings.reduce((t, h) => t + h.amount, 0n), wonTotal: 0n };
      },
    },
  },
};

/** Won HYPE Gemas still pending: Redeem stays pressable and says "Redeem fetches the latest yield first". */
export const RedeemFetchesYieldFirst: Story = {
  parameters: {
    data: {
      snapshot: (a: string): AccountSnapshot => {
        const s = demoSnapshot(a);
        // Won HYPE Gemas from a vault Source, all still pending.
        const hype = { vault: ETH_VAULTS[1].address, id: 2n };
        return { ...s, holdings: s.holdings.map((h) => ({ ...h, redeemable: 0n, eth: h.asset === "HYPE" ? hype : h.eth })) };
      },
    },
    screen: { eth: { advance: "open" } },
  },
};

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

/** A long-time Player: a few own Positions per chain (one ETH unlocked), Gemas won from about 200 Players across SOL, ETH and HYPE. */
const heavySnapshot = (a: string): AccountSnapshot => {
  const s = demoSnapshot(a);
  const PRICE = { SOL: 150, ETH: 2600, HYPE: 40 } as const;
  const DECIMALS = { SOL: 9n, ETH: 18n, HYPE: 18n } as const;
  const held = (n: number, asset: "SOL" | "ETH" | "HYPE", isOwn: boolean, owner: string, amount: bigint, redeemable: bigint) => ({
    holding: new PublicKey(demoKey(3000 + n)),
    source: new PublicKey(demoKey(4000 + n)),
    position: new PublicKey(demoKey(5000 + n)),
    isOwn,
    amount,
    reserved: 0n,
    free: amount,
    redeemable,
    pending: isOwn ? 0n : amount - redeemable,
    sourceDebt: 0n,
    unitNum: 10n ** (DECIMALS[asset] + 4n),
    unitDen: BigInt(PRICE[asset] * 1_000_000),
    sourceOwner: owner,
    asset,
    native: asset === "SOL",
    eth: asset === "SOL" ? null : { vault: ETH_VAULTS[asset === "ETH" ? 0 : 1].address, id: BigInt(n) },
    stakeMint: null,
  });
  const won = Array.from({ length: 230 }, (_, i) => {
    const asset = i % 9 < 5 ? "SOL" : i % 9 < 7 ? "ETH" : "HYPE";
    const amount = BigInt(90 + ((i * 7919) % 2400));
    const share = BigInt((i * 37) % 101);
    // Every 12th win is a second Source from a Player already beaten: they show as one row.
    return held(i, asset, false, demoKey(6000 + (i % 12 === 11 ? i - 9 : i)), amount, (amount * share) / 100n);
  });
  const own = [held(900, "SOL", true, a, 1800n, 600n), held(901, "HYPE", true, a, 650n, 0n)];
  const sol = (n: number, principal: number, debt: number): ChainPosition => ({
    address: new PublicKey(demoKey(700 + n)),
    asset: "SOL",
    principal,
    apy: 0.07,
    status: "locked",
    advances: 1,
    advance: { source: new PublicKey(demoKey(750 + n)), gemasIssued: 9000, horizonMonths: 3, debtGemas: Math.round(debt * 15_000) },
    debt,
    yieldAccrued: 0.01,
    native: null,
    eth: null,
  });
  const holdings = [...won, ...own];
  const total = (list: typeof holdings) => list.reduce((t, h) => t + h.amount, 0n);
  return {
    ...s,
    holdings,
    ownTotal: total(own),
    wonTotal: total(won),
    positions: [
      sol(1, 2, 0.061),
      sol(2, 5, 0),
      sol(3, 1, 0.052),
      ethPosition(1, "ETH", 0.5, ETH_VAULTS[0].address),
      ethPosition(2, "ETH", 1, ETH_VAULTS[0].address),
      { ...ethPosition(3, "ETH", 0.2, ETH_VAULTS[0].address, true), status: "unlocked" },
      ethPosition(4, "HYPE", 40, ETH_VAULTS[1].address),
    ],
  };
};

/** Hundreds of Players' Positions behind the won Gemas: each chain card lists the top 5, "Show all" opens the paged list. */
export const LongTimePlayer: Story = { parameters: { data: { snapshot: heavySnapshot }, screen: { eth: { advance: "open" } } } };

const openTab = (name: string): Story["play"] => async ({ canvasElement }) => {
  const open = await waitFor(() => within(canvasElement).getAllByRole("button", { name: /Get Gemas/ })[0], { timeout: 10_000 });
  await userEvent.click(open);
  const tab = await waitFor(() => within(document.body).getAllByRole("tab", { name: new RegExp(`^${name}`) })[0], { timeout: 10_000 });
  await userEvent.click(tab);
};

/** The Get Gemas sheet on the ETH tab. */
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

/** `/wallet/opening`: an ETH Lock crossing to Solana, one story per step. */
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
