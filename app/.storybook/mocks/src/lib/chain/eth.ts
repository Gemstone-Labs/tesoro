// Storybook: the Ethereum and HyperEVM market a Position form reads (balances, rate, faucet) is a fixed example; no RPC.
import { PublicKey } from "@solana/web3.js";
import { netOfVault, type EthMarket, type EthState, type EthVault, type VaultPosition } from "../../../../../src/lib/chain/eth";
import { screenData } from "../../../../../stories/screens/support/screen";

export * from "../../../../../src/lib/chain/eth";

const E = 10n ** 18n;

export async function fetchEthMarket(vault: EthVault, owner: `0x${string}`): Promise<EthMarket> {
  return {
    address: owner,
    ethBalance: vault.net === "hyperevm" ? E / 20n : E / 5n,
    simEth: 12n * E,
    allowance: 0n,
    quoteOpen: E / 2000n,
    quoteYield: E / 2000n,
    nextPositionId: 9n,
    rate: { baseRate: E, baseTime: 1_790_000_000n, apyBps: 700n, speedup: 4380n },
    faucetAmount: 10n * E,
    faucetAvailableAt: 0,
  };
}

const PRICE = { ETH: 3_180_000_000n, HYPE: 28_400_000n };
const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));

/** The Position's state on Solana for the story: an opening Position at the chosen step, or one with an open or paid-off Advance. */
export async function fetchEthState(_c: unknown, vault: string, id: bigint): Promise<EthState> {
  const { advance = "open", opening } = screenData().eth ?? {};
  const price = PRICE[netOfVault(vault).native];
  const bridge = { lastInSeq: 1n, lockedSeq: 1n, ownerEvm: "0x4ce2a8b91f0d3e57c1a6d9f2b08e7a3d51c6f9a2", principal: 2n * E, horizonMonths: 3, opened: true, lastYieldSeq: 0n, yieldCumulative: 0n, appliedYieldSeq: 0n, outSeq: 0n, unlockSent: false };
  const core = { position: key(Number(id)), principalWei: 2n * E, rateBps: 700, status: "locked" as const, advances: 1, openAdvance: advance === "open" ? 0 : null, cumulativeYield: 0n };
  const issued = 6200n;
  const unitNum = 10n ** 22n;
  const source = {
    key: key(40 + Number(id)),
    index: 0,
    horizonMonths: 3,
    math: { issued, returned: advance === "paid" ? issued : 0n, redeemed: 0n, yieldUnits: advance === "paid" ? (issued * unitNum) / price : 4_000_000_000_000_000n, unitNum, unitDen: price },
  };
  const holderEvm = bridge.ownerEvm;
  if (opening === "sent") return { bridge: null, core: null, source: null, claim: null, holderEvm, fetchedAt: Date.now() };
  if (opening === "delivered" || opening === "failed") return { bridge, core: null, source: null, claim: null, holderEvm, fetchedAt: Date.now() };
  if (opening === "recorded") return { bridge, core: { ...core, advances: 0, openAdvance: null }, source: null, claim: null, holderEvm, fetchedAt: Date.now() };
  return { bridge, core, source, claim: null, holderEvm, fetchedAt: Date.now() };
}

export async function fetchVaultPosition(vault: string): Promise<VaultPosition> {
  const paid = screenData().eth?.advance === "paid";
  void vault;
  return {
    owner: "0x4ce2a8b91f0d3e57c1a6d9f2b08e7a3d51c6f9a2",
    principalShares: 2n * E,
    principalUnderlying: 2n * E,
    openRate: E,
    heldShares: 2n * E,
    paidUnderlying: 0n,
    horizonMonths: 3,
    unlocked: false,
    accrued: paid ? 20_000_000_000_000_000n : 6_000_000_000_000_000n,
  };
}
