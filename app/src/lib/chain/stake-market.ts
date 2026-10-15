import "./polyfill";
import { PublicKey, type AccountInfo, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { CLUSTER } from "../cluster-settings";
import { parseTreasury, parseTreasuryVaultKey, parseVaultShares } from "./fees";
import {
  TESORO_CORE_ID,
  accrueNativeYieldIx,
  custodyPda,
  fetchNativeMarket,
  pda,
  rdI64,
  rdU64,
  s,
  treasuryPda,
  type NativeInfo,
  type NativeMarket,
  type TokenCustody,
} from "./native";
import {
  accrueStakePoolYieldIx,
  parseSolSource,
  parseStakePool,
  parseTokenApy,
  solSourcePda,
  stakePoolRate,
  tokenApyPda,
  tokenAta,
  tokenSymbol,
  tokenTreasuryVaultPda,
  type SolSourceView,
} from "./stake-pool";

/**
 * The Wallet's reads and payout accounts on a cluster with a real staking token (ADR 0010, `yieldModel` "real"), shaped like
 * the sim_lst ones so the cards and flows stay the same: the market's `pool` carries the stake pool's rate and the token's
 * trailing APY (speedup 1, real time), `simSol` the wallet's token balance. Shared with the keeper: relative imports only.
 */

type Info = AccountInfo<Buffer> | null;
const owned = (i: Info): Info => (i && i.owner.equals(TESORO_CORE_ID) ? i : null);

/** The Treasury's vault of `mint`: its original vault when that holds the token, otherwise the one at `["treasury_vault", mint]`. */
export function treasuryVaultOf(mint: PublicKey, treasury: Info, originalVault: Info): PublicKey {
  const key = treasury ? parseTreasuryVaultKey(treasury.data) : null;
  if (key && originalVault && originalVault.data.length >= 32 && new PublicKey(originalVault.data.subarray(0, 32)).equals(mint)) return new PublicKey(key);
  return tokenTreasuryVaultPda(mint);
}

/** Round one: the setting and the Treasury. */
export const stakeMarketKeys = () => [solSourcePda(), treasuryPda()];

/** Round two, once the token is known: its pool, APY, price feed, the wallet's token account and the Treasury's vault candidates. */
export function stakeMarketKeys2(wallet: PublicKey, source: SolSourceView, treasury: Info): PublicKey[] {
  const key = treasury ? parseTreasuryVaultKey(treasury.data) : null;
  return [source.pool, tokenApyPda(source.mint), pda([s("price"), source.mint.toBuffer()]), tokenAta(wallet, source.mint), tokenTreasuryVaultPda(source.mint), ...(key ? [new PublicKey(key)] : [])];
}

/** The setting from round one; null while no token is set. */
export const solSourceOf = (info: Info): SolSourceView | null => {
  const i = owned(info);
  return i ? parseSolSource(i.data) : null;
};

/** The market from the accounts of both rounds. Throws when the pool cannot be read. */
export function stakeMarketFrom(source: SolSourceView, treasuryInfo: Info, [poolInfo, apy, feed, ata, canonicalVault, originalVault = null]: Info[], nowSecs = Math.floor(Date.now() / 1000)): NativeMarket {
  const view = poolInfo ? parseStakePool(poolInfo.data) : null;
  const rate = view && view.poolMint.equals(source.mint) ? stakePoolRate(view.totalLamports, view.poolTokenSupply) : null;
  if (!view || !rate) throw new Error("The staking pool is not readable right now.");
  const apyView = owned(apy) ? parseTokenApy(apy!.data) : null;
  const priceInfo = owned(feed);
  const treasury = owned(treasuryInfo) ? parseTreasury(treasuryInfo!.data) : null;
  const vault = treasuryVaultOf(source.mint, owned(treasuryInfo), originalVault);
  const vaultInfo = vault.equals(tokenTreasuryVaultPda(source.mint)) ? canonicalVault : originalVault;
  return {
    pool: { baseRate: rate, baseTs: nowSecs, apyBps: apyView?.apyBps ?? 0, speedup: 1 },
    price: priceInfo && priceInfo.data.length >= 57 ? { microUsd: rdU64(priceInfo.data, 41), updatedTs: Number(rdI64(priceInfo.data, 49)) } : null,
    simSol: ata ? rdU64(ata.data, 64) : 0n,
    treasury,
    treasuryShares: treasury ? (vaultInfo && parseVaultShares(vaultInfo.data)) ?? 0n : null,
    token: { mint: source.mint, pool: source.pool, treasuryVault: vault, symbol: tokenSymbol(source.mint) },
  };
}

/** The Wallet's market on the active cluster: sim_lst in test mode, the staking token's pool on mainnet. Null when mainnet has no token set. */
export async function fetchMarket(c: Connection, wallet: PublicKey): Promise<NativeMarket | null> {
  if (CLUSTER.yieldModel !== "real") return fetchNativeMarket(c, wallet);
  const [setting, treasury] = await c.getMultipleAccountsInfo(stakeMarketKeys(), "confirmed");
  const source = solSourceOf(setting);
  if (!source) return null;
  return stakeMarketFrom(source, treasury, await c.getMultipleAccountsInfo(stakeMarketKeys2(wallet, source, treasury), "confirmed"));
}

/**
 * The payout accounts of a Position's custody: undefined for a simSOL custody, else its token, its stake pool and the Treasury's
 * vault of that token. Read at send time, so a payout of any Position (also one opened with an earlier token) names the right ones.
 */
export async function loadTokenCustody(c: Connection, position: PublicKey): Promise<TokenCustody | undefined> {
  const [cust, treasury] = await c.getMultipleAccountsInfo([custodyPda(position), treasuryPda()], "confirmed");
  if (!cust) return undefined;
  const info = tokenOfCustody(cust.data);
  if (!info) return undefined;
  const key = treasury ? parseTreasuryVaultKey(treasury.data) : null;
  const original = key ? await c.getAccountInfo(new PublicKey(key), "confirmed") : null;
  return { mint: info.mint, pool: info.pool, treasuryVault: treasuryVaultOf(info.mint, owned(treasury), original) };
}

/** The token and pool a custody names, when it is valued by a stake pool (null for simSOL). */
export function tokenOfCustody(data: Uint8Array): { mint: PublicKey; pool: PublicKey } | null {
  const SPACE = 8 + 2 + 5 * 32 + 5 * 8;
  if (data.length < SPACE + 9 || data[SPACE] !== 2) return null;
  return { pool: new PublicKey(data.subarray(74, 106)), mint: new PublicKey(data.subarray(106, 138)) };
}

/** The permissionless yield crank that fits the custody: the stake pool one (Yield Fee in tokens) or the simSOL mint. */
export const accrueYieldIx = (info: Pick<NativeInfo, "position" | "openAdvance" | "stakePool" | "pool">, tok?: TokenCustody): TransactionInstruction =>
  info.stakePool && tok ? accrueStakePoolYieldIx(info.position, info.pool, tok.treasuryVault, info.openAdvance) : accrueNativeYieldIx(info.position, info.openAdvance);
