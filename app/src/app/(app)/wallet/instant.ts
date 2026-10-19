"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "@/lib/account";
import { getChain } from "@/lib/chain/client";
import { fetchAccountState } from "@/lib/chain/read";
import { fetchVaultTreasuries } from "@/lib/chain/treasury";
import { fetchLiveTreasury, netOfVault } from "@/lib/chain/eth";
import { instantTryCap, instantUnavailable, planInstant, ratesOf, treasuryBalanceUnits, type InstantCandidate, type InstantLine, type VaultTreasuryView } from "@/lib/chain/fees";
import { LAMPORTS, rateAt, speedupOf, type NativeMarket } from "@/lib/chain/native";
import { unitsForTokens } from "@/lib/chain/stake";
import type { ChainHolding } from "@/lib/chain/read";
import type { PublicKey } from "@solana/web3.js";
import type { Chain } from "@/lib/mock";
import type { InstantOffer, InstantRow } from "./MoneySheets";

const UNITS: Record<Chain, number> = { SOL: LAMPORTS, ETH: 1e18, HYPE: 1e18 };
const TOKEN: Record<Chain, string> = { SOL: "test SOL", ETH: "ETH", HYPE: "HYPE" };

/** Won Gemas the Account holds that Instant Redeem could buy: free, still waiting on yield, from a Source the app can pay out. */
export const instantCandidates = (holdings: ChainHolding[]) => holdings.filter((h) => !h.isOwn && h.pending > 0n && (h.native || h.eth));

const holder = (h: ChainHolding) => `Won · ${h.sourceOwner.slice(0, 4)}…${h.sourceOwner.slice(-4)}`;

type InstantPlan = { holding: ChainHolding; line: InstantLine }[];

/** Pays for the won Gemas in order from each treasury's capacity: the SOL treasury vault and the mirrors of the EVM vault treasuries. */
function buildPlan(won: ChainHolding[], market: NativeMarket | null, mirrors: Map<string, VaultTreasuryView> | null, live: Map<string, bigint> | null = null) {
  const rates = ratesOf(market?.treasury);
  const caps = new Map<string, bigint>();
  // The Treasury pays from the earned, unminted Yield Fee plus its vault, exactly as the program counts it; short means "unavailable", not an error.
  if (market?.treasury && market.stake?.treasuryTokens != null) {
    // Mainnet: the Treasury's balance is tokens in the stake vault, valued at the pool's rate.
    caps.set("SOL", unitsForTokens(market.stake.treasuryTokens, market.stake.rate));
  } else if (market?.treasury && market.treasuryShares !== null && market.treasuryClaim) {
    caps.set("SOL", treasuryBalanceUnits({ ...market.treasuryClaim, vaultShares: market.treasuryShares, rate: rateAt(market.pool), speedup: speedupOf(market.pool), nowSec: Math.floor(Date.now() / 1000) }));
  }
  // The mirror is what the last report said. The vault's own balance may be higher (nothing was reported since it grew): that
  // much can be tried, because Redeem now fetches the latest report first and re-checks against the refreshed mirror.
  for (const [vault, view] of mirrors ?? []) caps.set(vault, instantTryCap(view, live?.get(vault) ?? null));
  const candidates: InstantCandidate[] = won.map((h) => ({ key: h.holding.toBase58(), capKey: h.eth ? h.eth.vault.toLowerCase() : "SOL", free: h.pending, unitNum: h.unitNum, unitDen: h.unitDen }));
  const lines = planInstant(candidates, caps, rates.instantFeeBps);
  const byKey = new Map(won.map((h) => [h.holding.toBase58(), h]));
  const plan: InstantPlan = lines.map((line) => ({ holding: byKey.get(line.key)!, line }));
  return { rates, caps, plan };
}

/**
 * The Instant Redeem side of the Redeem sheet, from the Account's snapshot and the treasuries that pay it: the simSOL the
 * treasury vault holds (SOL) and the bridge's mirror of each EVM vault's treasury (ETH, HYPE). Null when the Account holds no won Gemas.
 * `plan` pairs every line "Redeem now" would send with its holding.
 */
export function useInstantRedeem(asset?: Chain): { offer: InstantOffer | null; plan: InstantPlan; behind: Set<string>; freshPlan: (authority: PublicKey) => Promise<InstantPlan> } {
  const { snapshot } = useAccount();
  const market = snapshot?.market ?? null;
  const won = useMemo(() => instantCandidates(snapshot?.holdings ?? []).filter((h) => !asset || h.asset === asset), [snapshot, asset]);
  const vaults = useMemo(() => [...new Set(won.flatMap((h) => (h.eth ? [h.eth.vault.toLowerCase()] : [])))].sort(), [won]);
  const [mirrors, setMirrors] = useState<Map<string, VaultTreasuryView> | null>(null);
  const [live, setLive] = useState<Map<string, bigint> | null>(null);
  useEffect(() => {
    if (vaults.length === 0) return;
    let stopped = false;
    fetchVaultTreasuries(getChain().base, vaults.map((vault) => ({ vault, eid: netOfVault(vault).eid })))
      .then((m) => !stopped && setMirrors(m))
      .catch(() => !stopped && setMirrors(new Map()));
    Promise.all(vaults.map(async (vault) => [vault, await fetchLiveTreasury(vault).catch(() => null)] as const))
      .then((rows) => !stopped && setLive(new Map(rows.flatMap(([v, b]) => (b === null ? [] : [[v, b] as const])))))
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [vaults]);

  /** The plan again from a fresh Account read and fresh treasury mirrors: yield may have accrued since the Player confirmed. */
  const freshPlan = useCallback(async (authority: PublicKey) => {
    const fresh = await fetchAccountState(authority, { fresh: true });
    const candidates = instantCandidates(fresh.holdings).filter((h) => !asset || h.asset === asset);
    const freshVaults = [...new Set(candidates.flatMap((h) => (h.eth ? [h.eth.vault.toLowerCase()] : [])))].sort();
    const freshMirrors = freshVaults.length ? await fetchVaultTreasuries(getChain().base, freshVaults.map((vault) => ({ vault, eid: netOfVault(vault).eid }))) : null;
    return buildPlan(candidates, fresh.market, freshMirrors).plan;
  }, [asset]);

  const view = useMemo((): { offer: InstantOffer | null; plan: InstantPlan } => {
    if (won.length === 0) return { offer: null, plan: [] };
    const { rates, caps, plan } = buildPlan(won, market, mirrors, live);
    const rows: InstantRow[] = plan.map(({ holding: h, line }) => ({
      key: line.key,
      asset: h.asset,
      from: holder(h),
      gemas: Number(line.gemas),
      amount: Number(line.payout) / UNITS[h.asset],
      token: h.stakeMint && market?.stake ? market.stake.token.symbol : TOKEN[h.asset],
      later: !h.native,
    }));
    const assets = [...new Set(won.map((h) => h.asset))];
    const available = assets.map((asset) => {
      const keys = asset === "SOL" ? ["SOL"] : won.filter((h) => h.asset === asset && h.eth).map((h) => h.eth!.vault.toLowerCase());
      const known = keys.filter((k) => caps.has(k));
      return { asset, amount: known.length ? Number(known.reduce((s, k) => s + caps.get(k)!, 0n)) / UNITS[asset] : null, token: asset === "SOL" && market?.stake ? market.stake.token.symbol : TOKEN[asset] };
    });
    const setUp = Boolean(market?.treasury);
    const unavailable = instantUnavailable({ setUp, payableRows: rows.length });
    return { offer: { rows, feePct: rates.instantFeeBps / 100, available, unavailable, fetchesYield: won.some((h) => h.eth) }, plan };
  }, [won, market, mirrors, live]);
  /** Vaults whose own Treasury holds more than the bridge's mirror shows: a report refreshes the mirror. */
  const behind = useMemo(() => new Set([...(mirrors ?? [])].filter(([v, m]) => (live?.get(v) ?? 0n) > m.balance).map(([v]) => v)), [mirrors, live]);
  return { ...view, behind, freshPlan };
}
