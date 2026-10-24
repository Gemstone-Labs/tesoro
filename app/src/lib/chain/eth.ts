import "./polyfill";
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from "@solana/web3.js";
import { createPublicClient, http, isAddress, parseAbi, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { HOODI_RPC, HYPEREVM_RPC, hoodi, hyperEvmTestnet } from "@/lib/chains";
import { CLUSTER } from "@/lib/cluster-settings";

export { HOODI_RPC, HYPEREVM_RPC };
import { TESORO_CORE_ID, meta, parseSource, pda, rdU32, rdU64, s, sourcePda, u64 } from "./native";
import { unitsToRepay, type SourceMath } from "./ledger";
import { basketPda, spillPda, type LineRef } from "./basket";
import { coreIx } from "./core-ix";
import { DEFAULT_YIELD_FEE_BPS, accruedYield, advanceUnits, cashOut } from "./yield";

/**
 * EVM Positions (Ethereum Hoodi and HyperEVM testnet) on the Solana ledger, over LayerZero V2. Accounts and wire
 * format follow bridge/scripts/flow.ts and docs/cross-chain.md. Simulated yield: SimLST, 1 month = 10 min.
 * Client-safe (web3.js + viem only): the server relay in src/server/eth-bridge.ts imports the same helpers.
 */

export const BRIDGE_ID = new PublicKey("5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ");
/** Tesoro chain tag for Ethereum: Hoodi (LayerZero eid 40449) in test mode, Ethereum mainnet (eid 30101) on the mainnet cluster. */
export const HOODI_EID = CLUSTER.id === "mainnet" ? 30101 : 40449;
export const HOODI_CHAIN_BYTE = 1;
/** HyperEVM: testnet (chain 998, LayerZero eid 40362) in test mode, mainnet (chain 999, eid 30367) on the mainnet cluster. */
export const HYPEREVM_EID = CLUSTER.id === "mainnet" ? 30367 : 40362;
export const HYPEREVM_CHAIN_BYTE = 2;
const MAINNET = CLUSTER.id === "mainnet";
export const LZ_SCAN_API = MAINNET ? "https://scan.layerzero-api.com/v1" : "https://scan-testnet.layerzero-api.com/v1";
export const lzScanUrl = (txHash: string) => `https://${MAINNET ? "" : "testnet."}layerzeroscan.com/tx/${txHash}`;
export const hoodiTx = (hash: string) => `https://${MAINNET ? "" : "hoodi."}etherscan.io/tx/${hash}`;
export const hyperEvmTx = (hash: string) => (MAINNET ? `https://hyperevmscan.io/tx/${hash}` : `https://testnet.purrsec.com/tx/${hash}`);

/** `hoodi` is the Ethereum slot: Hoodi in test mode, Ethereum mainnet on the mainnet cluster (chains.ts picks the chain and RPC). */
export type NetKey = "hoodi" | "hyperevm";

/** An EVM network a vault can live on: its LayerZero id, the tesoro_core chain byte, RPC and native token. */
export interface EvmNet {
  key: NetKey;
  chain: Chain;
  /** LayerZero endpoint id, also the Tesoro chain tag in payloads. */
  eid: number;
  /** tesoro_core `SourceChain` byte (Ethereum 1, HyperEVM 2). */
  chainByte: number;
  rpc: string;
  /** Short name for copy. */
  label: string;
  /** Native token (gas and the LayerZero fee) and the Wallet's chain tab. */
  native: "ETH" | "HYPE";
  tx: (hash: string) => string;
}

export const NETS: Record<NetKey, EvmNet> = {
  hoodi: { key: "hoodi", chain: hoodi, eid: HOODI_EID, chainByte: HOODI_CHAIN_BYTE, rpc: HOODI_RPC, label: MAINNET ? "Ethereum" : "Hoodi", native: "ETH", tx: hoodiTx },
  hyperevm: { key: "hyperevm", chain: hyperEvmTestnet, eid: HYPEREVM_EID, chainByte: HYPEREVM_CHAIN_BYTE, rpc: HYPEREVM_RPC, label: "HyperEVM", native: "HYPE", tx: hyperEvmTx },
};

/**
 * The SimLST vault (PositionVaultOApp) and its SimLST token on each EVM network: the ONE place the app learns them.
 * A redeploy of the vaults (docs/deployments.md runbook) is a one-line edit per network here, then `bridge/scripts/lz.ts wire`
 * for the new vault. The keeper reads vaults off the Position ids on chain and needs no address.
 */
const SIM_VAULT_ADDRESSES = {
  hoodi: { vault: "0x7A996874B9Ffc35cC36bF154D02a23D16863a087", lst: "0xD82840623A7a00C37b0883d221Fa84e39ddA2a28" },
  hyperevm: { vault: "0xdD12E37A9C35137Be8a4F871507986dA4671B20B", lst: "0xC8A9AccD25ABDCF3FCBDE7123Cef8239B5bE7eF3" },
} as const satisfies Record<NetKey, { vault: Address; lst: Address }>;

export interface EthVault {
  key: "sim" | "sim-hype" | "wsteth" | "khype";
  net: NetKey;
  label: string;
  address: Address;
  lst: Address;
  symbol: string;
  simulated: boolean;
  /** Stake-and-open zap (contracts/src/StakeZap.sol): when set, the Player may open with the plain coin. */
  zap?: Address;
}

/**
 * Lido wstETH on Ethereum mainnet (docs.lido.fi/deployed-contracts). The vault (contracts/script, WstETHRateAdapter) and the
 * LidoZap have no address until the orchestrator deploys them: set NEXT_PUBLIC_WSTETH_VAULT and NEXT_PUBLIC_LIDO_ZAP on the
 * mainnet cluster and the ETH tab lists them.
 */
export const WSTETH_TOKEN: Address = "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0";
/**
 * Kinetiq kHYPE on HyperEVM mainnet (kinetiq.xyz/docs/contracts-and-audits; token and StakingAccountant read on chain 2026-10-15).
 * The vault (contracts/script/DeployMainnetKHype.s.sol) has no address until the orchestrator deploys it: set
 * NEXT_PUBLIC_KHYPE_VAULT (and NEXT_PUBLIC_KINETIQ_ZAP for HYPE -> kHYPE through StakingManager 0x393D0B87Ed38fc779FD9611144aE649BA6082109).
 */
export const KHYPE_TOKEN: Address = "0xfD739d4e423301CE9385c1fb8850539D657C296D";
export const KHYPE_ACCOUNTANT: Address = "0x9209648Ec9D448EF57116B73A2f081835643dc7A";

export interface VaultEnv {
  wstethVault?: string;
  lidoZap?: string;
  khypeVault?: string;
  kinetiqZap?: string;
}

const addr = (v: string | undefined): Address | undefined => (v && isAddress(v) ? v : undefined);

/**
 * The vaults a cluster lists. Test mode: the two SimLST vaults. Mainnet: the real-token vaults whose address is set,
 * nothing simulated. The real-Lido wstETH vault on Hoodi (0x61B4...57b5) is wired on Solana but not listed: no wstETH faucet.
 */
export function buildEthVaults(clusterId: "test" | "mainnet", env: VaultEnv): EthVault[] {
  if (clusterId === "test") {
    return [
      { key: "sim", net: "hoodi", label: "Simulated ETH (simETH)", address: SIM_VAULT_ADDRESSES.hoodi.vault, lst: SIM_VAULT_ADDRESSES.hoodi.lst, symbol: "simETH", simulated: true },
      { key: "sim-hype", net: "hyperevm", label: "Simulated HYPE (simHYPE)", address: SIM_VAULT_ADDRESSES.hyperevm.vault, lst: SIM_VAULT_ADDRESSES.hyperevm.lst, symbol: "simHYPE", simulated: true },
    ];
  }
  const out: EthVault[] = [];
  const wsteth = addr(env.wstethVault);
  if (wsteth) out.push({ key: "wsteth", net: "hoodi", label: "Lido staked ETH (wstETH)", address: wsteth, lst: WSTETH_TOKEN, symbol: "wstETH", simulated: false, zap: addr(env.lidoZap) });
  const khype = addr(env.khypeVault);
  if (khype) out.push({ key: "khype", net: "hyperevm", label: "Kinetiq staked HYPE (kHYPE)", address: khype, lst: KHYPE_TOKEN, symbol: "kHYPE", simulated: false, zap: addr(env.kinetiqZap) });
  return out;
}

/** Next inlines NEXT_PUBLIC_ variables only when they are written out in full, so each is spelled out. */
export const ETH_VAULTS: EthVault[] = buildEthVaults(CLUSTER.id, {
  wstethVault: process.env.NEXT_PUBLIC_WSTETH_VAULT,
  lidoZap: process.env.NEXT_PUBLIC_LIDO_ZAP,
  khypeVault: process.env.NEXT_PUBLIC_KHYPE_VAULT,
  kinetiqZap: process.env.NEXT_PUBLIC_KINETIQ_ZAP,
});
export const isKnownVault = (v: string) => ETH_VAULTS.some((x) => x.address.toLowerCase() === v.toLowerCase());
export const vaultByAddress = (v: string) => ETH_VAULTS.find((x) => x.address.toLowerCase() === v.toLowerCase()) ?? null;
export const vaultsOn = (net: NetKey) => ETH_VAULTS.filter((v) => v.net === net);
/** The network a vault lives on. Vaults the app no longer lists (retired Hoodi redeploys) are Hoodi. */
export const netOfVault = (v: string): EvmNet =>
  NETS[vaultByAddress(v)?.net ?? (RETIRED_HYPEREVM_VAULTS.includes(v.toLowerCase()) ? "hyperevm" : "hoodi")];
/** HyperEVM vaults replaced by the per-Position yield redeploy (2026-10-03); their Positions are abandoned. */
const RETIRED_HYPEREVM_VAULTS = ["0x23b17a4c55867406e7cd5602c664e1447400c4a3".toLowerCase()];

export const WEI = 10n ** 18n;
export const ETH_DECIMALS = 18;
/** Wall-clock minutes of one simulated month (SimLST speedup 4,380). */
export const ETH_SIM_MONTH_MIN = 10;
/** The vault's own `principalUnderlying` must fit u64 on Solana. */
export const MAX_PRINCIPAL_WEI = (1n << 64n) - 1n;
export const LZ_FEE_HEADROOM_PCT = 20n;

// ---- ABIs -------------------------------------------------------------------------------------

export const vaultAbi = parseAbi([
  "function lst() view returns (address)",
  "function nextPositionId() view returns (uint64)",
  "function quotePositionLocked() view returns (uint256)",
  "function quoteYieldAccrued() view returns (uint256)",
  "function rateSource() view returns (address)",
  "function accruedYield(uint64) view returns (uint256)",
  "function payableYield(uint64) view returns (uint256)",
  "function getPosition(uint64) view returns ((address owner, uint256 principalShares, uint256 principalUnderlying, uint256 openRate, uint256 paidUnderlying, uint256 frozenAccrued, uint256 a, uint256 b, uint256 d, uint256 heldShares, uint256 apyBps, uint256 speedup, uint64 openTime, uint64 outSeq, uint64 inSeq, uint8 horizonMonths, bool unlocked))",
  "function treasuryBalance() view returns (uint256)",
  "function reportedAccrued(uint64) view returns (uint256)",
  "error ExceedsAccruedYield(uint256 requested, uint256 available)",
  "error InsufficientShares(uint256 needed, uint256 spendable)",
  "function openPosition(uint256 lstAmount, uint8 horizonMonths) payable returns (uint64 id)",
  "function reportYield(uint64 id) payable",
  "event PositionLocked(uint64 indexed positionId, address indexed owner, uint256 shares, uint8 horizonMonths, uint64 seq)",
  "event YieldPaid(uint64 indexed positionId, address indexed to, uint256 amountUnderlying, uint256 shares, uint64 seq)",
  "event InstantPaid(uint64 indexed positionId, address indexed to, uint256 amountUnderlying, uint256 shares, uint64 seq)",
]);

export const lstAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function faucet(address to)",
  "function faucetAmount() view returns (uint256)",
  "function faucetCooldown() view returns (uint256)",
  "function lastFaucet(address) view returns (uint256)",
  "function underlyingPerShare() view returns (uint256)",
  "function baseRate() view returns (uint256)",
  "function baseTime() view returns (uint256)",
  "function apyBps() view returns (uint256)",
  "function speedup() view returns (uint256)",
]);

/** The vault's exchange-rate source (WstETHRateAdapter, KHypeRateAdapter; SimLST itself on test vaults). */
const rateSourceAbi = parseAbi(["function underlyingPerShare() view returns (uint256)"]);

/**
 * Public EVM RPCs rate-limit per request ("Request exceeds defined limit" on HyperEVM) and answer slowly under load
 * (about 3 s a call), so reads are batched into one HTTP request per tick and a call gets 30 s and a slow retry
 * instead of viem's 10 s and 150 ms.
 */
export const evmTransport = (rpc?: string) => http(rpc, { batch: true, timeout: 30_000, retryCount: 4, retryDelay: 800 });

const clients = new Map<NetKey, PublicClient>();
export function evmClient(net: EvmNet): PublicClient {
  let c = clients.get(net.key);
  if (!c) clients.set(net.key, (c = createPublicClient({ chain: net.chain, transport: evmTransport(net.rpc) }) as PublicClient));
  return c;
}

/**
 * Several reads at once: one `multicall` where the chain has Multicall3 (Hoodi), parallel calls where it does not
 * (HyperEVM testnet has none, and viem refuses to batch there).
 */
async function readMany(c: PublicClient, contracts: readonly { address: Address; abi: any; functionName: string; args?: readonly unknown[] }[]): Promise<unknown[]> {
  if (c.chain?.contracts?.multicall3) return c.multicall({ allowFailure: false, contracts: contracts as never }) as Promise<unknown[]>;
  return Promise.all(contracts.map((x) => c.readContract(x as never)));
}

// ---- Position ids and PDAs ----------------------------------------------------------------------

const hexBytes = (h: string, len: number) => {
  const b = Buffer.from(h.replace(/^0x/, "").padStart(len * 2, "0"), "hex");
  if (b.length !== len) throw new Error(`need ${len} bytes`);
  return b;
};

/** vault address (20 bytes) | vault position id (u64 BE) | 4 zero bytes: the id the bridge and tesoro_core key on. */
export function ethPositionId(vault: string, id: bigint | number): Buffer {
  const b = Buffer.alloc(32);
  hexBytes(vault, 20).copy(b, 0);
  new DataView(b.buffer, b.byteOffset, b.byteLength).setBigUint64(20, BigInt(id), false);
  return b;
}
/**
 * Ids the relay creates a bridge inbox record for: Positions the vault has opened (`nextPositionId` is
 * the last one) and the next INIT_AHEAD, which the app creates before its `openPosition` lands.
 */
export const INIT_AHEAD = 3n;
export const initPositionIdAllowed = (id: bigint, lastId: bigint) => id >= 1n && id <= lastId + INIT_AHEAD;

/** Inverse of `ethPositionId`; null when the bytes are not in that shape. */
export function parseEthPositionId(id: Uint8Array): { vault: Address; id: bigint } | null {
  if (id.length !== 32 || id.slice(28).some((x) => x !== 0)) return null;
  const vault = `0x${Buffer.from(id.slice(0, 20)).toString("hex")}` as Address;
  return { vault, id: new DataView(id.buffer, id.byteOffset, id.byteLength).getBigUint64(20, false) };
}

const u32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const BRIDGE_STORE = pda([s("Store")], BRIDGE_ID);
export const BRIDGE_AUTHORITY = pda([s("authority")], BRIDGE_ID);
export const bridgeStore = () => BRIDGE_STORE;
/** The network a Position id belongs to: its first 20 bytes are the vault. */
const netOfPid = (pid: Uint8Array) => netOfVault(`0x${Buffer.from(pid.subarray(0, 20)).toString("hex")}`);
export const bridgePeerPda = (vault: string) => pda([s("Peer"), BRIDGE_STORE.toBuffer(), u32be(netOfVault(vault).eid), hexBytes(vault, 32)], BRIDGE_ID);
/** The bridge's mirror of a vault's treasury: `["treasury", eid u32 BE, vault address left-padded to 32 bytes]`. */
export const vaultTreasuryPda = (eid: number, vault: string) => pda([s("treasury"), u32be(eid), hexBytes(vault, 32)], BRIDGE_ID);
export const bridgePositionPda = (pid: Buffer) => pda([s("Position"), u32be(netOfPid(pid).eid), pid], BRIDGE_ID);
export const corePositionPda = (pid: Buffer) => pda([s("position"), Buffer.from([netOfPid(pid).chainByte]), pid]);
export const coreAccountPda = (authority: PublicKey) => pda([s("account"), authority.toBuffer()]);
export const evmLinkPda = (evm: string) => pda([s("evm"), hexBytes(evm, 20)], BRIDGE_ID);
export const claimPda = (account: PublicKey, source: PublicKey) => pda([s("claim"), account.toBuffer(), source.toBuffer()], BRIDGE_ID);
/** The holder's Instant Redeems of one Source, recorded by `instant_redeem_to_evm`. */
export const instantClaimPda = (account: PublicKey, source: PublicKey) => pda([s("instant"), account.toBuffer(), source.toBuffer()], BRIDGE_ID);
export const sourceAuthPda = (net: EvmNet) => pda([s("source_auth"), Buffer.from([net.chainByte])]);
export const configPda = () => pda([s("config")]);

/** The text the EVM wallet signs (EIP-191) to link its address to the Account. */
export const linkMessage = (account: PublicKey) => `Tesoro: link EVM address to Account ${account.toBase58()}`;

/** Anchor discriminators, `sha256("global:<name>")[..8]`, precomputed (the browser needs no hash library). */
export const DISC = {
  link_evm: "a99a949b50190692",
  set_evm_address: "8a0f7d6709c95c4f",
  redeem_to_evm: "f8cfc48f001a142e",
  unlock: "659b28159ebd38cb",
  take_advance: "3a6a527644c370bc",
  take_advance_onchain: "775856577194b45b",
  init_position: "c5140a0161a0b15b",
  apply_locked: "2f27cfcfbbab2be7",
  apply_yield: "6e7ea020cbc9228f",
  send_unlock: "c572c4f9aa4badcc",
  send_pay_yield: "d0c0a50ea5a3d845",
  instant_redeem_to_evm: "36abe0d58e2860c2",
  send_pay_instant: "114f041c33a0cfa6",
  quote_send: "cf0031d6a0d34cd3",
} as const;
export const disc = (name: keyof typeof DISC) => Buffer.from(DISC[name], "hex");

// ---- Instructions (signed by the Account's Solana wallet) ---------------------------------------

/** Points the Account at its EVM address (`tesoro_core::set_evm_address`). */
export const setEvmAddressIx = (authority: PublicKey, evm: string) =>
  new TransactionInstruction({
    programId: TESORO_CORE_ID,
    keys: [meta(authority, false, true), meta(coreAccountPda(authority), true)],
    data: Buffer.concat([disc("set_evm_address"), hexBytes(evm, 20)]),
  });

/** Proves the EVM wallet controls `evm`: `signature` is its EIP-191 signature of `linkMessage(account)`. The bridge recovers the signer on chain. */
export const linkEvmIx = (authority: PublicKey, evm: string, signature: Hex, payer: PublicKey = authority) =>
  new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [meta(authority, false, true), meta(coreAccountPda(authority)), meta(evmLinkPda(evm), true), meta(SystemProgram.programId), meta(payer, true, true)],
    data: Buffer.concat([disc("link_evm"), hexBytes(evm, 20), hexBytes(signature, 65)]),
  });

/** A `LineRef` as the bridge's Borsh instruction data carries it: side u8, due_at i64, class u8, tranche u8. */
const lineBytes = (l: LineRef) => {
  const b = Buffer.alloc(11);
  b.writeUInt8(l.side, 0);
  b.writeBigInt64LE(l.dueAt, 1);
  b.writeUInt8(l.class, 9);
  b.writeUInt8(l.tranche, 10);
  return b;
};

/**
 * Redeems Gemas of one line of an ETH or HYPE Source and records the payout owed on its EVM chain (never `tesoro_core::redeem`, which would burn
 * them unrecorded). `target.accounts` are the Source's book and checkpoint pages. `send_pay_yield` then delivers the payout.
 */
export const redeemToEvmIx = (holder: PublicKey, position: PublicKey, source: PublicKey, gemas: bigint, net: EvmNet, target: { line: LineRef; accounts: PublicKey[] }) => {
  const account = coreAccountPda(holder);
  return new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      meta(holder, true, true),
      meta(BRIDGE_STORE),
      meta(pda([s("authority")], BRIDGE_ID)),
      meta(sourceAuthPda(net)),
      meta(account, true),
      meta(position, true),
      meta(source, true),
      meta(basketPda(account), true),
      meta(spillPda(account), true),
      meta(claimPda(account, source), true),
      meta(TESORO_CORE_ID),
      meta(SystemProgram.programId),
      ...target.accounts.map((k) => meta(k, true)),
    ],
    data: Buffer.concat([disc("redeem_to_evm"), lineBytes(target.line), u64(gemas)]),
  });
};

/**
 * Debt must be zero. Returns the Principal on the vault's chain once `send_unlock` is delivered. `open` is the Position's open Advance
 * (its Source, then its book and checkpoint pages), closed here.
 */
export const coreUnlockIx = (owner: PublicKey, position: PublicKey, open: { index: number; accounts: PublicKey[] } | null = null) =>
  coreIx(
    "unlock",
    { owner_authority: owner, owner_account: coreAccountPda(owner), economy: pda([s("economy")]), position },
    {},
    open ? [meta(sourcePda(position, open.index), true), ...open.accounts.map((k) => meta(k, true))] : [],
  );

// ---- Solana readers -----------------------------------------------------------------------------

const rdU128 = (d: Uint8Array, o: number) => rdU64(d, o) + (rdU64(d, o + 8) << 64n);

export interface BridgePositionView {
  lastInSeq: bigint;
  lockedSeq: bigint;
  ownerEvm: string;
  principal: bigint;
  horizonMonths: number;
  opened: boolean;
  lastYieldSeq: bigint;
  yieldCumulative: bigint;
  appliedYieldSeq: bigint;
  outSeq: bigint;
  unlockSent: boolean;
  /** What the vault Treasury held at the latest Yield Report (source-asset units). */
  treasuryBalance: bigint;
  /** What Instant Redeems on this Position's vault had been paid when that report was made. */
  instantPaid: bigint;
  /** Vault block time (unix seconds) of the latest Yield Report applied to this record. */
  reportTime: bigint;
}

/** `BridgePosition`: 172 bytes, `treasury_balance` u128 at 172, `instant_paid` u128 at 188, `report_time` u64 at 204. */
export const BRIDGE_POSITION_LEN = 172 + 16 + 16 + 8;

/** Null for a record in the old layout: its vault is abandoned, and it reads as absent. */
export function parseBridgePosition(d: Uint8Array): BridgePositionView | null {
  if (d.length !== BRIDGE_POSITION_LEN) return null;
  // disc 8, eid 4, position_id 32, bump 1
  return {
    lastInSeq: rdU64(d, 45),
    lockedSeq: rdU64(d, 53),
    ownerEvm: `0x${Buffer.from(d.subarray(61, 81)).toString("hex")}`,
    principal: rdU128(d, 113),
    horizonMonths: d[129],
    opened: d[130] === 1,
    lastYieldSeq: rdU64(d, 131),
    yieldCumulative: rdU128(d, 139),
    appliedYieldSeq: rdU64(d, 155),
    outSeq: rdU64(d, 163),
    unlockSent: d[171] === 1,
    treasuryBalance: rdU128(d, 172),
    instantPaid: rdU128(d, 188),
    reportTime: rdU64(d, 204),
  };
}

export interface EthCoreView {
  position: PublicKey;
  principalWei: bigint;
  rateBps: number;
  status: "locked" | "unlocked";
  advances: number;
  openAdvance: number | null;
  cumulativeYield: bigint;
}

export function parseCorePosition(position: PublicKey, d: Uint8Array): EthCoreView {
  let o = 8 + 1 + 32 + 32 + 1 + 32 + 1; // disc, bump, id, owner, chain, asset, decimals
  const principalWei = rdU64(d, o);
  const rateBps = new DataView(d.buffer, d.byteOffset, d.byteLength).getUint16(o + 8, true);
  o += 10;
  const status = d[o] === 0 ? "locked" : "unlocked";
  o += 1;
  const advances = rdU32(d, o);
  o += 4;
  const openAdvance = d[o] === 1 ? rdU32(d, o + 1) : null;
  o += (d[o] === 1 ? 5 : 1) + 8; // open_advance, last_seq
  return { position, principalWei, rateBps, status, advances, openAdvance, cumulativeYield: rdU64(d, o) };
}

/** `Claim` and `InstantClaim` share a layout: disc 8, three keys, gemas_total, units_total, units_sent. */
export function parseClaim(d: Uint8Array): EthClaim | null {
  return d.length >= 128 ? { gemasTotal: rdU64(d, 104), unitsTotal: rdU64(d, 112), unitsSent: rdU64(d, 120) } : null;
}

export interface EthClaim {
  gemasTotal: bigint;
  unitsTotal: bigint;
  unitsSent: bigint;
}

export interface EthState {
  bridge: BridgePositionView | null;
  core: EthCoreView | null;
  /** The requested Advance's Source (the latest by default; kept after Debt reaches zero). */
  source: { key: PublicKey; index: number; horizonMonths: number; math: SourceMath } | null;
  /** The holder's Claim on `source` (the redemption owed to the holder for that Source). */
  claim: EthClaim | null;
  /** The holder's Instant Claim on `source` (what Tesoro's Treasury owes the holder for Gemas sold instantly). */
  instantClaim: EthClaim | null;
  /** The EVM address stored on the holder's Account: where redemptions are paid. */
  holderEvm: string | null;
  fetchedAt: number;
}

/** The index of `source` among the Position's Advances, or null when it is not one of them. */
export function ethSourceIndex(position: PublicKey, source: PublicKey, advances: number): number | null {
  for (let i = 0; i < advances; i++) if (sourcePda(position, i).equals(source)) return i;
  return null;
}

/** One read of an ETH Position on Solana: the bridge's inbox record, the tesoro_core Position, one Advance's Source (the latest unless `sourceIndex` is given) and the holder's Claim on it. */
export async function fetchEthState(c: Connection, vault: string, id: bigint, holder: PublicKey, sourceIndex?: number): Promise<EthState> {
  const pid = ethPositionId(vault, id);
  const corePk = corePositionPda(pid);
  const holderAccount = coreAccountPda(holder);
  const [bp, cp, acct] = await c.getMultipleAccountsInfo([bridgePositionPda(pid), corePk, holderAccount], "confirmed");
  const bridge = bp ? parseBridgePosition(Buffer.from(bp.data)) : null;
  const core = cp ? parseCorePosition(corePk, Buffer.from(cp.data)) : null;
  const holderEvm = acct && acct.data.length >= 61 ? `0x${Buffer.from(acct.data.subarray(41, 61)).toString("hex")}` : null;
  let source: EthState["source"] = null;
  let claim: EthClaim | null = null;
  let instantClaim: EthClaim | null = null;
  const index = sourceIndex ?? (core ? core.advances - 1 : -1);
  if (core && Number.isInteger(index) && index >= 0 && index < core.advances) {
    const key = sourcePda(corePk, index);
    const [src, cl, ic] = await c.getMultipleAccountsInfo([key, claimPda(holderAccount, key), instantClaimPda(holderAccount, key)], "confirmed");
    if (src) source = parseSource(key, Buffer.from(src.data));
    if (cl) claim = parseClaim(cl.data);
    if (ic) instantClaim = parseClaim(ic.data);
  }
  return { bridge, core, source, claim, instantClaim, holderEvm, fetchedAt: Date.now() };
}

/** Underlying wei the vault paid `to` for this Position since block `fromBlock` (`YieldPaid` or, for an Instant Redeem, `InstantPaid` events: per recipient, unlike the Position-wide `paidUnderlying`). */
export async function fetchPaidTo(vault: string, id: bigint, to: string, fromBlock: bigint, eventName: "YieldPaid" | "InstantPaid" = "YieldPaid"): Promise<bigint> {
  const logs = await evmClient(netOfVault(vault)).getContractEvents({ address: vault as Address, abi: vaultAbi, eventName, args: { positionId: id, to: to as Address }, fromBlock, toBlock: "latest" });
  return logs.reduce((sum, l) => sum + (l.args.amountUnderlying ?? 0n), 0n);
}

/** Whether the Account's EVM address is set and proven (an `EvmLink` pointing at the Account exists). */
export async function fetchLinkState(c: Connection, authority: PublicKey, evm: string) {
  const account = coreAccountPda(authority);
  const [acct, link] = await c.getMultipleAccountsInfo([account, evmLinkPda(evm)], "confirmed");
  const stored = acct ? `0x${Buffer.from(acct.data.subarray(41, 61)).toString("hex")}` : null;
  const linked = !!link && new PublicKey(link.data.subarray(8 + 20, 8 + 52)).equals(account);
  return { accountExists: !!acct, storedEvm: stored, addressSet: !!stored && stored.toLowerCase() === evm.toLowerCase(), linked };
}

// ---- Hoodi readers ------------------------------------------------------------------------------

export interface SimRate {
  baseRate: bigint;
  baseTime: bigint;
  apyBps: bigint;
  speedup: bigint;
}

/** SimLST `underlyingPerShare()`: constant since the per-Position yield model (docs/yield-model.md). */
export function simRateAt(r: SimRate): bigint {
  return r.baseRate;
}

export interface EthMarket {
  address: Address;
  ethBalance: bigint;
  /** The Player's balance of the vault's staking token (simETH, simHYPE, wstETH, kHYPE). */
  simEth: bigint;
  allowance: bigint;
  /** Native fee for `openPosition` / `reportYield` messages (before headroom). */
  quoteOpen: bigint;
  quoteYield: bigint;
  nextPositionId: bigint;
  rate: SimRate;
  /** The APY an Advance is quoted on: SimLST's configured rate; on a real-token vault its PeerConfig rate, or null while that is unset. */
  apyBps: bigint | null;
  faucetAmount: bigint;
  /** Unix seconds the faucet is next available for this address (0 when available now). */
  faucetAvailableAt: number;
}

/** The slice of a viem client the market read uses; tests pass a fake. */
export type MarketClient = Pick<PublicClient, "readContract" | "getBalance"> & { chain?: PublicClient["chain"]; multicall?: PublicClient["multicall"] };

/**
 * The APY every Advance on a vault is sized on: the `rate_bps` of the vault's `PeerConfig` in tesoro_bridge (set with
 * `set_peer_config`, ops derive it from the rate source's recent growth, docs/cross-chain.md). Null while the peer is
 * missing or the rate is 0: the form then shows "APY —" and offers no Advance.
 */
export async function fetchPeerRateBps(base: Pick<Connection, "getAccountInfo">, vault: string): Promise<number | null> {
  const info = await base.getAccountInfo(bridgePeerPda(vault), "confirmed");
  if (!info || info.data.length < 43) return null;
  const rate = info.data.readUInt16LE(41);
  return rate > 0 ? rate : null;
}

export async function fetchEthMarket(vault: EthVault, owner: Address, client?: MarketClient, base?: Pick<Connection, "getAccountInfo">): Promise<EthMarket> {
  const c = (client ?? evmClient(NETS[vault.net])) as PublicClient;
  const lst = { address: vault.lst, abi: lstAbi } as const;
  const v = { address: vault.address, abi: vaultAbi } as const;
  const common = [
    { ...lst, functionName: "balanceOf", args: [owner] },
    { ...lst, functionName: "allowance", args: [owner, vault.address] },
    { ...v, functionName: "quotePositionLocked" },
    { ...v, functionName: "quoteYieldAccrued" },
    { ...v, functionName: "nextPositionId" },
  ];
  if (!vault.simulated) {
    // A real staking token has no faucet and no SimLST rate fields: the rate comes from the vault's rate source.
    const [r, ethBalance] = await Promise.all([readMany(c, [...common, { ...v, functionName: "rateSource" }]), c.getBalance({ address: owner })]);
    const [underlyingPerShare] = await readMany(c, [{ address: r[5] as Address, abi: rateSourceAbi, functionName: "underlyingPerShare" }]);
    const peerRate = base ? await fetchPeerRateBps(base, vault.address).catch(() => null) : null;
    return {
      address: owner,
      ethBalance,
      simEth: r[0] as bigint,
      allowance: r[1] as bigint,
      quoteOpen: r[2] as bigint,
      quoteYield: r[3] as bigint,
      nextPositionId: r[4] as bigint,
      rate: { baseRate: underlyingPerShare as bigint, baseTime: BigInt(Math.floor(Date.now() / 1000)), apyBps: 0n, speedup: 1n },
      apyBps: peerRate === null ? null : BigInt(peerRate),
      faucetAmount: 0n,
      faucetAvailableAt: 0,
    };
  }
  const [r, ethBalance] = await Promise.all([
    readMany(c, [
      ...common,
      { ...lst, functionName: "baseRate" },
      { ...lst, functionName: "baseTime" },
      { ...lst, functionName: "apyBps" },
      { ...lst, functionName: "speedup" },
      { ...lst, functionName: "faucetAmount" },
      { ...lst, functionName: "faucetCooldown" },
      { ...lst, functionName: "lastFaucet", args: [owner] },
    ]),
    c.getBalance({ address: owner }),
  ]);
  const last = r[11] as bigint;
  const availableAt = last === 0n ? 0 : Number(last + (r[10] as bigint));
  return {
    address: owner,
    ethBalance,
    simEth: r[0] as bigint,
    allowance: r[1] as bigint,
    quoteOpen: r[2] as bigint,
    quoteYield: r[3] as bigint,
    nextPositionId: r[4] as bigint,
    rate: { baseRate: r[5] as bigint, baseTime: r[6] as bigint, apyBps: r[7] as bigint, speedup: r[8] as bigint },
    apyBps: r[7] as bigint,
    faucetAmount: r[9] as bigint,
    faucetAvailableAt: availableAt,
  };
}

export interface VaultPosition {
  owner: Address;
  principalShares: bigint;
  principalUnderlying: bigint;
  openRate: bigint;
  heldShares: bigint;
  paidUnderlying: bigint;
  /** Accrued Yield frozen at Unlock (the formula stops there). */
  frozenAccrued: bigint;
  openTime: bigint;
  horizonMonths: number;
  unlocked: boolean;
  /**
   * Accrued Yield right now by the vault's formula (underlying wei, gross: the Yield Fee is taken at cash-out; cumulative: includes what was
   * paid out). Computed on read, never recorded; Solana only learns it from a Yield Report.
   */
  accrued: bigint;
}

type VaultPositionRaw = Omit<VaultPosition, "accrued" | "horizonMonths"> & { horizonMonths: number | bigint };

export async function fetchVaultPosition(vault: string, id: bigint): Promise<VaultPosition | null> {
  const c = evmClient(netOfVault(vault));
  const v = { address: vault as Address, abi: vaultAbi } as const;
  const [p, accrued] = (await readMany(c, [
    { ...v, functionName: "getPosition", args: [id] },
    { ...v, functionName: "accruedYield", args: [id] },
  ])) as [VaultPositionRaw, bigint];
  if (/^0x0+$/.test(p.owner)) return null;
  return {
    owner: p.owner,
    principalShares: p.principalShares,
    principalUnderlying: p.principalUnderlying,
    openRate: p.openRate,
    heldShares: p.heldShares,
    paidUnderlying: p.paidUnderlying,
    frozenAccrued: p.frozenAccrued,
    openTime: p.openTime,
    horizonMonths: Number(p.horizonMonths),
    unlocked: p.unlocked,
    accrued,
  };
}

/** With `LZ_FEE_HEADROOM_PCT` on top; the vault refunds the excess to the caller. */
/** The vault's own Treasury balance right now (source-asset units), read from the vault. */
export const fetchLiveTreasury = (vault: string): Promise<bigint> =>
  evmClient(netOfVault(vault)).readContract({ address: vault as Address, abi: vaultAbi, functionName: "treasuryBalance" });

export const withHeadroom = (fee: bigint) => (fee * (100n + LZ_FEE_HEADROOM_PCT)) / 100n;

// ---- Math ---------------------------------------------------------------------------------------

/** Advance sizing as `Position::open_advance`: the whole projected yield (ticket 31), floored to whole Gemas ($0.01 each). */
export function quoteEthAdvance(principalWei: bigint, rateBps: number, months: number, priceMicroUsd: bigint) {
  const projectedUnits = advanceUnits(principalWei, rateBps, months);
  const gemas = (projectedUnits * priceMicroUsd) / 10n ** BigInt(ETH_DECIMALS + 4);
  return { projectedUnits, gemas };
}

/** The `min_gemas` argument of a `take_advance` or `take_advance_onchain` instruction: its last eight bytes, little-endian. */
export function advanceFloorOf(data: Uint8Array): bigint {
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(data.byteLength - 8, true);
}

/** Finds the single Advance after optional setup instructions in an oracle-signed transaction. */
export function advanceFloorIn(ixs: readonly TransactionInstruction[]): bigint {
  const advances = ixs.filter((ix) => ix.programId.equals(TESORO_CORE_ID) && [DISC.take_advance, DISC.take_advance_onchain].some((d) => d === Buffer.from(ix.data.subarray(0, 8)).toString("hex")));
  if (advances.length !== 1) throw new Error("The transaction must contain exactly one Advance.");
  return advanceFloorOf(advances[0].data);
}

/** Principal in underlying wei for `shares` at `rate` (as `openPosition` computes it). */
export const underlyingOf = (shares: bigint, rate: bigint) => (shares * rate) / WEI;

/**
 * Debt in Gemas if the yield accrued on Hoodi were reported and applied now. Debt only falls on
 * Solana when a `YieldAccrued` message is applied, so this is what the next Yield Report would leave.
 */
export function projectedEthDebt(source: SourceMath | null, accruedUnits: bigint): bigint {
  if (!source) return 0n;
  const y = accruedUnits > source.yieldUnits ? accruedUnits : source.yieldUnits;
  const live = source.issued > source.returned ? source.issued - source.returned : 0n;
  const cov = source.unitNum === 0n ? 0n : (y * source.unitDen) / source.unitNum;
  return live - (cov < live ? cov : live);
}

/**
 * Unlock Estimate (ms since epoch): when the yield accrued on the vault covers the
 * Debt. An estimate, never a promise. Null when it cannot be projected.
 */
export function ethUnlockEstimateMs(args: {
  source: SourceMath | null;
  position: Pick<VaultPosition, "heldShares" | "principalUnderlying" | "paidUnderlying" | "accrued">;
  rate: SimRate;
  nowMs: number;
}): number | null {
  const { source, position, rate, nowMs } = args;
  if (!source || position.heldShares === 0n) return null;
  const needed = unitsToRepay(source) + source.yieldUnits;
  const have = position.accrued > source.yieldUnits ? position.accrued : source.yieldUnits;
  if (have >= needed) return nowMs;
  // Yield is linear on the Position's own Principal (docs/yield-model.md): accrued(t) = accrued_now + per_second * t.
  const window = 1_000_000n;
  const perWindow = accruedYield({
    principal: position.principalUnderlying,
    rateBps: Number(rate.apyBps),
    elapsedSec: window,
    speedup: rate.speedup,
  });
  if (perWindow === 0n) return null;
  const seconds = ((needed - have) * window + perWindow - 1n) / perWindow;
  return nowMs + Number(seconds) * 1000;
}

/** ETH base units a redeem of `gemas` pays: their value (floor, as the program computes it) less the Yield Fee (one floor). */
export const redeemPayoutWei = (source: SourceMath, gemas: bigint, yieldFeeBps = DEFAULT_YIELD_FEE_BPS) =>
  cashOut((gemas * source.unitNum) / source.unitDen, yieldFeeBps, 0).payout;

export const fmtEth = (wei: bigint | number, digits = 4) =>
  (Number(wei) / 1e18).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const shortHex = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
