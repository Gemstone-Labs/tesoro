/** Testnet deployments shown in the Status band. Every address must appear in docs/deployments.md (status.test.ts). */
export type Deployment = { name: string; address: string; href: string };

const solana = (name: string, address: string): Deployment => ({
  name,
  address,
  href: `https://explorer.solana.com/address/${address}?cluster=devnet`,
});
const hoodi = (name: string, address: string): Deployment => ({
  name,
  address,
  href: `https://hoodi.etherscan.io/address/${address}`,
});

export const DEPLOYMENTS: { chain: string; items: Deployment[] }[] = [
  {
    chain: "Solana devnet",
    items: [
      solana("tesoro_core", "AR9c426k5531GhYNSvQAz3YhpBvCc5x22YaKCesTAckh"),
      solana("block_puzzle", "5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj"),
      solana("holdem", "CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE"),
      solana("sim_lst", "WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F"),
      solana("tesoro_bridge", "5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ"),
    ],
  },
  {
    chain: "Ethereum Hoodi",
    items: [hoodi("PositionVault (simETH)", "0xF3F2361432e5066588B96c9A9acF0b7b2907AE0a")],
  },
];

export const short = (address: string) => `${address.slice(0, 4)}…${address.slice(-4)}`;
