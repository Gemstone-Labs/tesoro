import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ChainPockets, type Pocket, type PocketSource } from "@/app/(app)/wallet/ChainPockets";
import { PositionTile } from "@/app/(app)/wallet/PositionTile";
import type { Chain } from "@/lib/mock/types";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const NAMES = ["Quartz Axolotl", "Topaz Lion", "Opal Heron", "Jade Badger", "Onyx Lynx", "Garnet Otter", "Beryl Mole", "Amber Ibis"];

/** `n` Players the won Gemas came from, sample names (no Account keys, so no avatars). */
const sources = (n: number, seed: number): PocketSource[] =>
  Array.from({ length: n }, (_, i) => {
    const gemas = 90 + ((i * 7919 + seed) % 2400);
    return { key: `${seed}-${i}`, account: null, owner: `${NAMES[i % NAMES.length]} ${i + 1}`, gemas, redeemable: Math.round(gemas * (((i * 37 + seed) % 100) / 100)) };
  });

const tile = (chain: Chain, n: number, principal: string, state: "repaying" | "paid", inMin: number) => (
  <PositionTile
    key={`${chain}${n}`}
    chain={chain}
    label={`${chain} Lock ${n}`}
    state={state}
    principal={principal}
    debt={state === "repaying" ? "1,240 Gemas" : "0"}
    apy="5.7%"
    unlockAt={state === "repaying" ? NOW + inMin * 60_000 : null}
    now={NOW}
    series={null}
    compact
  />
);

const pocket = (chain: Chain, positions: React.ReactNode[], n: number, gemas: number, asset: number): Pocket => {
  const src = sources(n, chain.length * 31);
  const redeemable = src.reduce((t, s) => t + s.redeemable, 0);
  return { chain, positions, closed: [], sources: src, gemas, gemasAsset: asset, redeemable, redeemableAsset: (asset * redeemable) / gemas };
};

const HEAVY: Pocket[] = [
  pocket("SOL", [tile("SOL", 1, "2.000 SOL", "repaying", 8), tile("SOL", 2, "5.000 SOL", "paid", 0), tile("SOL", 3, "1.000 SOL", "repaying", 64)], 126, 76_936, 5.1291),
  pocket("ETH", [tile("ETH", 1, "0.5000 ETH", "repaying", 30), tile("ETH", 2, "0.2000 ETH", "paid", 0)], 61, 33_525, 0.12894),
  pocket("HYPE", [tile("HYPE", 1, "40.00 HYPE", "repaying", 22)], 39, 23_411, 5.85),
];

const meta = {
  title: "Components/wallet/ChainPockets",
  component: ChainPockets,
  args: { pockets: HEAVY, onRedeem: () => {} },
} satisfies Meta<typeof ChainPockets>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A long-time Player: a few own Positions per chain, Gemas won from hundreds of Players. "Show all" opens the paged list. */
export const Heavy: Story = {};

/** One chain, a couple of wins. */
export const New: Story = { args: { pockets: [pocket("SOL", [tile("SOL", 1, "1.000 SOL", "repaying", 9)], 3, 1_450, 0.0967)] } };
