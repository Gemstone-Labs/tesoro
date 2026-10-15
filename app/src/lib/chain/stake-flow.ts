import "./polyfill";
import type { Connection, PublicKey } from "@solana/web3.js";
import { BlockPuzzleChain, type ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import { createAccountIx } from "./match-flow";
import { parseTreasury, type TreasuryRates } from "./fees";
import { TESORO_CORE_ID, pda, rdI64, rdU64, s, treasuryPda, type PriceFeedView } from "./native";
import {
  parseSolSource,
  parseStakePool,
  effectiveApyBps,
  parseTokenApy,
  planOpenWithSol,
  planOpenWithToken,
  solSourcePda,
  tokenApyPda,
  tokenAta,
  type SolSourceView,
  type StakePoolView,
} from "./stake-pool";

/** What the Open a Position form needs on a cluster with a real staking token. */
export interface StakeMarket {
  source: SolSourceView;
  pool: StakePoolView;
  /** The APY an Advance is sized on: the lower of the published trailing APY and the ceiling; 0 when stale or no ceiling. */
  apyBps: number;
  price: PriceFeedView | null;
  treasury: TreasuryRates | null;
  /** The wallet's plain SOL, lamports. */
  sol: bigint;
  /** The wallet's balance of the staking token. */
  tokens: bigint;
}

/** Reads the setting, then the pool, APY, price, Treasury and the wallet's balances. Null when no token is set yet. */
export async function fetchStakeMarket(c: Connection, wallet: PublicKey, nowSecs = Math.floor(Date.now() / 1000)): Promise<StakeMarket | null> {
  const srcInfo = await c.getAccountInfo(solSourcePda(), "confirmed");
  const source = srcInfo && srcInfo.owner.equals(TESORO_CORE_ID) ? parseSolSource(srcInfo.data) : null;
  if (!source) return null;
  const feed = pda([s("price"), source.mint.toBuffer()]);
  const [pool, apy, price, treasury, ata, sol] = await Promise.all([
    c.getAccountInfo(source.pool, "confirmed"),
    c.getAccountInfo(tokenApyPda(source.mint), "confirmed"),
    c.getAccountInfo(feed, "confirmed"),
    c.getAccountInfo(treasuryPda(), "confirmed"),
    c.getAccountInfo(tokenAta(wallet, source.mint), "confirmed"),
    c.getBalance(wallet, "confirmed"),
  ]);
  const view = pool ? parseStakePool(pool.data) : null;
  if (!view || !view.poolMint.equals(source.mint)) throw new Error("The staking pool is not readable right now.");
  const apyView = apy && apy.owner.equals(TESORO_CORE_ID) ? parseTokenApy(apy.data) : null;
  return {
    source,
    pool: view,
    apyBps: effectiveApyBps(apyView, nowSecs) ?? 0,
    price: price && price.owner.equals(TESORO_CORE_ID) && price.data.length >= 57 ? { microUsd: rdU64(price.data, 41), updatedTs: Number(rdI64(price.data, 49)) } : null,
    treasury: treasury && treasury.owner.equals(TESORO_CORE_ID) ? parseTreasury(treasury.data) : null,
    sol: BigInt(sol),
    tokens: ata ? rdU64(ata.data, 64) : 0n,
  };
}

/**
 * Opens a Position and takes the first Advance in one signed transaction (`create_account` in front when the wallet has
 * no Account yet). `lamports` stakes plain SOL through the pool first; `tokens` locks the token the wallet holds.
 */
export async function openStakePosition(
  signer: ChainSigner,
  market: StakeMarket,
  input: { lamports: bigint } | { tokens: bigint },
  months: number,
  onStep: (s: string) => void = () => undefined,
): Promise<{ signature: string; position: string }> {
  onStep("Preparing");
  const account = await getChain().base.getAccountInfo(BlockPuzzleChain.coreAccount(signer.publicKey));
  const nonce = BigInt(Date.now());
  const plan =
    "lamports" in input
      ? await planOpenWithSol({ owner: signer.publicKey, nonce, lamports: input.lamports, pool: market.pool, source: market.source, months })
      : await planOpenWithToken({ owner: signer.publicKey, nonce, tokens: input.tokens, source: market.source, months });
  onStep("Opening the Position");
  const ixs = account ? plan.instructions : [await createAccountIx(signer.publicKey), ...plan.instructions];
  const signature = await getChain().sendBase(signer, ixs);
  return { signature, position: plan.position.toBase58() };
}
