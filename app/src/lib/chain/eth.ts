import "./polyfill";
import { PublicKey, SystemProgram, TransactionInstruction, type Connection } from "@solana/web3.js";
import { createPublicClient, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { hoodi } from "viem/chains";
import { TESORO_CORE_ID, meta, parseSource, pda, rdU32, rdU64, s, sourcePda, u64 } from "./native";
import { unitsToRepay, type SourceMath } from "./ledger";

/**
 * Ethereum Positions (Hoodi) on the Solana ledger, over LayerZero V2. Accounts and wire format follow
 * bridge/scripts/flow.ts and docs/cross-chain.md. Simulated yield: SimLST, 1 month = 10 min.
 * Client-safe (web3.js + viem only): the server relay in src/server/eth-bridge.ts imports the same helpers.
 */

export const BRIDGE_ID = new PublicKey("5bzDVZKazyknCCcLRAyNz3TNxDfiPdPcQEavvBfdwvTQ");
/** Tesoro chain tag for Ethereum Hoodi (LayerZero eid). */
export const HOODI_EID = 40449;
export const HOODI_CHAIN_BYTE = 1;
export const HOODI_RPC = process.env.NEXT_PUBLIC_HOODI_RPC ?? "https://ethereum-hoodi-rpc.publicnode.com";
export const LZ_SCAN_API = "https://scan-testnet.layerzero-api.com/v1";
export const lzScanUrl = (txHash: string) => `https://testnet.layerzeroscan.com/tx/${txHash}`;
export const hoodiTx = (hash: string) => `https://hoodi.etherscan.io/tx/${hash}`;

export interface EthVault {
  key: "sim";
  label: string;
  address: Address;
  lst: Address;
  symbol: string;
  simulated: boolean;
}

/**
 * The Hoodi vaults the app opens Positions in. The real-Lido wstETH vault (0x61B4...57b5) is wired
 * on Solana but is not listed: there is no wstETH faucet (docs/cross-chain.md).
 */
export const ETH_VAULTS: EthVault[] = [
  {
    key: "sim",
    label: "Simulated ETH (simETH)",
    address: "0xF3F2361432e5066588B96c9A9acF0b7b2907AE0a",
    lst: "0x23B17A4c55867406E7CD5602c664E1447400c4a3",
    symbol: "simETH",
    simulated: true,
  },
];
export const isKnownVault = (v: string) => ETH_VAULTS.some((x) => x.address.toLowerCase() === v.toLowerCase());
export const vaultByAddress = (v: string) => ETH_VAULTS.find((x) => x.address.toLowerCase() === v.toLowerCase()) ?? null;

export const WEI = 10n ** 18n;
export const ETH_DECIMALS = 18;
/** Wall-clock minutes of one simulated month (SimLST speedup 4,320). */
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
  "function accruedYield(uint64) view returns (uint256)",
  "function payableYield(uint64) view returns (uint256)",
  "function getPosition(uint64) view returns ((address owner, uint256 principalShares, uint256 principalUnderlying, uint256 openRate, uint256 heldShares, uint256 paidUnderlying, uint256 frozenAccrued, uint64 openTime, uint64 outSeq, uint64 inSeq, uint8 horizonMonths, bool unlocked))",
  "function openPosition(uint256 lstAmount, uint8 horizonMonths) payable returns (uint64 id)",
  "function reportYield(uint64 id) payable",
  "event PositionLocked(uint64 indexed positionId, address indexed owner, uint256 shares, uint8 horizonMonths, uint64 seq)",
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

let pub: PublicClient | null = null;
export function hoodiClient(): PublicClient {
  if (!pub) pub = createPublicClient({ chain: hoodi, transport: http(HOODI_RPC) }) as PublicClient;
  return pub;
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
export const bridgePeerPda = (vault: string) => pda([s("Peer"), BRIDGE_STORE.toBuffer(), u32be(HOODI_EID), hexBytes(vault, 32)], BRIDGE_ID);
export const bridgePositionPda = (pid: Buffer) => pda([s("Position"), u32be(HOODI_EID), pid], BRIDGE_ID);
export const corePositionPda = (pid: Buffer) => pda([s("position"), Buffer.from([HOODI_CHAIN_BYTE]), pid]);
export const coreAccountPda = (authority: PublicKey) => pda([s("account"), authority.toBuffer()]);
export const evmLinkPda = (evm: string) => pda([s("evm"), hexBytes(evm, 20)], BRIDGE_ID);
export const claimPda = (account: PublicKey, source: PublicKey) => pda([s("claim"), account.toBuffer(), source.toBuffer()], BRIDGE_ID);
export const sourceAuthPda = () => pda([s("source_auth"), Buffer.from([HOODI_CHAIN_BYTE])]);
export const holdingPda = (account: PublicKey, source: PublicKey) => pda([s("holding"), account.toBuffer(), source.toBuffer()]);
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
  init_position: "c5140a0161a0b15b",
  apply_locked: "2f27cfcfbbab2be7",
  apply_yield: "6e7ea020cbc9228f",
  send_unlock: "c572c4f9aa4badcc",
  send_pay_yield: "d0c0a50ea5a3d845",
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
export const linkEvmIx = (authority: PublicKey, evm: string, signature: Hex) =>
  new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [meta(authority, true, true), meta(coreAccountPda(authority)), meta(evmLinkPda(evm), true), meta(SystemProgram.programId)],
    data: Buffer.concat([disc("link_evm"), hexBytes(evm, 20), hexBytes(signature, 65)]),
  });

/** Redeems Gemas of an ETH Source and records the payout owed on Hoodi (never `tesoro_core::redeem`, which would burn them unrecorded). */
export const redeemToEvmIx = (holder: PublicKey, position: PublicKey, source: PublicKey, gemas: bigint) => {
  const account = coreAccountPda(holder);
  return new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [
      meta(holder, true, true),
      meta(BRIDGE_STORE),
      meta(pda([s("authority")], BRIDGE_ID)),
      meta(sourceAuthPda()),
      meta(account, true),
      meta(position),
      meta(source, true),
      meta(holdingPda(account, source), true),
      meta(claimPda(account, source), true),
      meta(TESORO_CORE_ID),
      meta(SystemProgram.programId),
    ],
    data: Buffer.concat([disc("redeem_to_evm"), u64(gemas)]),
  });
};

/** Debt must be zero. Returns the Principal on Hoodi once `send_unlock` is delivered. */
export const coreUnlockIx = (owner: PublicKey, position: PublicKey) =>
  new TransactionInstruction({
    programId: TESORO_CORE_ID,
    keys: [meta(owner, false, true), meta(coreAccountPda(owner)), meta(position, true)],
    data: disc("unlock"),
  });

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
}

export function parseBridgePosition(d: Uint8Array): BridgePositionView {
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

export interface EthClaim {
  gemasTotal: bigint;
  unitsTotal: bigint;
  unitsSent: bigint;
}

export interface EthState {
  bridge: BridgePositionView | null;
  core: EthCoreView | null;
  /** The latest Advance's Source (kept after Debt reaches zero). */
  source: { key: PublicKey; index: number; horizonMonths: number; math: SourceMath } | null;
  claim: EthClaim | null;
  fetchedAt: number;
}

/** One read of an ETH Position on Solana: the bridge's inbox record, the tesoro_core Position, its latest Source and the holder's Claim. */
export async function fetchEthState(c: Connection, vault: string, id: bigint, holder: PublicKey): Promise<EthState> {
  const pid = ethPositionId(vault, id);
  const corePk = corePositionPda(pid);
  const [bp, cp] = await c.getMultipleAccountsInfo([bridgePositionPda(pid), corePk], "confirmed");
  const bridge = bp ? parseBridgePosition(Buffer.from(bp.data)) : null;
  const core = cp ? parseCorePosition(corePk, Buffer.from(cp.data)) : null;
  let source: EthState["source"] = null;
  let claim: EthClaim | null = null;
  if (core && core.advances > 0) {
    const key = sourcePda(corePk, core.advances - 1);
    const [src, cl] = await c.getMultipleAccountsInfo([key, claimPda(coreAccountPda(holder), key)], "confirmed");
    if (src) source = parseSource(key, Buffer.from(src.data));
    if (cl) {
      const d = Buffer.from(cl.data);
      claim = { gemasTotal: rdU64(d, 104), unitsTotal: rdU64(d, 112), unitsSent: rdU64(d, 120) };
    }
  }
  return { bridge, core, source, claim, fetchedAt: Date.now() };
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

const YEAR = 31_536_000n;
/** SimLST `underlyingPerShare()` at unix second `t`, as the contract computes it. */
export function simRateAt(r: SimRate, t: number): bigint {
  const elapsed = BigInt(Math.max(0, Math.floor(t))) - r.baseTime;
  return r.baseRate + (r.baseRate * r.apyBps * (elapsed > 0n ? elapsed : 0n) * r.speedup) / (10_000n * YEAR);
}

export interface EthMarket {
  address: Address;
  ethBalance: bigint;
  simEth: bigint;
  allowance: bigint;
  /** Native fee for `openPosition` / `reportYield` messages (before headroom). */
  quoteOpen: bigint;
  quoteYield: bigint;
  nextPositionId: bigint;
  rate: SimRate;
  faucetAmount: bigint;
  /** Unix seconds the faucet is next available for this address (0 when available now). */
  faucetAvailableAt: number;
}

export async function fetchEthMarket(vault: EthVault, owner: Address): Promise<EthMarket> {
  const c = hoodiClient();
  const lst = { address: vault.lst, abi: lstAbi } as const;
  const v = { address: vault.address, abi: vaultAbi } as const;
  const [r, ethBalance] = await Promise.all([
    c.multicall({
      allowFailure: false,
      contracts: [
        { ...lst, functionName: "balanceOf", args: [owner] },
        { ...lst, functionName: "allowance", args: [owner, vault.address] },
        { ...v, functionName: "quotePositionLocked" },
        { ...v, functionName: "quoteYieldAccrued" },
        { ...v, functionName: "nextPositionId" },
        { ...lst, functionName: "baseRate" },
        { ...lst, functionName: "baseTime" },
        { ...lst, functionName: "apyBps" },
        { ...lst, functionName: "speedup" },
        { ...lst, functionName: "faucetAmount" },
        { ...lst, functionName: "faucetCooldown" },
        { ...lst, functionName: "lastFaucet", args: [owner] },
      ],
    }),
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
  horizonMonths: number;
  unlocked: boolean;
  /** Yield accrued on Hoodi so far (underlying wei), reported to Solana or not. */
  accrued: bigint;
}

export async function fetchVaultPosition(vault: string, id: bigint): Promise<VaultPosition | null> {
  const c = hoodiClient();
  const v = { address: vault as Address, abi: vaultAbi } as const;
  const [p, accrued] = await c.multicall({
    allowFailure: false,
    contracts: [
      { ...v, functionName: "getPosition", args: [id] },
      { ...v, functionName: "accruedYield", args: [id] },
    ],
  });
  if (/^0x0+$/.test(p.owner)) return null;
  return { ...p, accrued };
}

/** With `LZ_FEE_HEADROOM_PCT` on top; the vault refunds the excess to the caller. */
export const withHeadroom = (fee: bigint) => (fee * (100n + LZ_FEE_HEADROOM_PCT)) / 100n;

// ---- Math ---------------------------------------------------------------------------------------

/** Advance sizing as `Position::open_advance`: 100% of the projected yield, floored to whole Gemas ($0.01 each). */
export function quoteEthAdvance(principalWei: bigint, rateBps: number, months: number, priceMicroUsd: bigint) {
  const projectedUnits = (principalWei * BigInt(rateBps) * BigInt(months)) / (12n * 10_000n);
  const gemas = (projectedUnits * priceMicroUsd) / 10n ** BigInt(ETH_DECIMALS + 4);
  return { projectedUnits, gemas };
}

/** Principal in underlying wei for `shares` at `rate` (as `openPosition` computes it). */
export const underlyingOf = (shares: bigint, rate: bigint) => (shares * rate) / WEI;

/**
 * Debt in Gemas if the yield accrued on Hoodi were reported and applied now. Debt only falls on
 * Solana when a `YieldAccrued` message is applied, so this is what "Report yield" would leave.
 */
export function projectedEthDebt(source: SourceMath | null, accruedUnits: bigint): bigint {
  if (!source) return 0n;
  const y = accruedUnits > source.yieldUnits ? accruedUnits : source.yieldUnits;
  const live = source.issued > source.returned ? source.issued - source.returned : 0n;
  const cov = source.unitNum === 0n ? 0n : (y * source.unitDen) / source.unitNum;
  return live - (cov < live ? cov : live);
}

/**
 * Unlock Estimate (ms since epoch, simulated clock): when the yield accrued on Hoodi covers the
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
  const growth = rate.baseRate * rate.apyBps * rate.speedup;
  if (growth === 0n) return null;
  // As PositionVault: accrued(t) = paid + held * rate(t) / 1e18 - principal, so
  // accrued(t) >= needed  <=>  rate(t) >= (needed + principal - paid) * 1e18 / held
  const target = needed + position.principalUnderlying - position.paidUnderlying;
  if (target <= 0n) return nowMs;
  const targetRate = (target * WEI + position.heldShares - 1n) / position.heldShares;
  if (targetRate <= rate.baseRate) return nowMs;
  const seconds = ((targetRate - rate.baseRate) * 10_000n * YEAR + growth - 1n) / growth;
  return Number(rate.baseTime + seconds) * 1000;
}

/** ETH base units a redeem of `gemas` pays (floor, as the program computes it). */
export const redeemPayoutWei = (source: SourceMath, gemas: bigint) => (gemas * source.unitNum) / source.unitDen;

export const fmtEth = (wei: bigint | number, digits = 4) =>
  (Number(wei) / 1e18).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const shortHex = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
