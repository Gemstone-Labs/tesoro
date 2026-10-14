"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "@/lib/account";
import { getChain } from "@/lib/chain/client";
import { fetchAccountState } from "@/lib/chain/read";
import { fetchVaultTreasuries } from "@/lib/chain/treasury";
import { netOfVault } from "@/lib/chain/eth";
import { planInstant, ratesOf, solPayoutCapacity, type InstantCandidate, type InstantLine, type VaultTreasuryView } from "@/lib/chain/fees";
import { LAMPORTS, rateAt, type NativeMarket } from "@/lib/chain/native";
import type { ChainHolding } from "@/lib/chain/read";
import type { PublicKey } from "@solana/web3.js";
import type { Chain } from "@/lib/mock";
import type { InstantOffer, InstantRow } from "./MoneySheets";

const UNITS: Record<Chain, number> = { SOL: LAMPORTS, ETH: 1e18, HYPE: 1e18 };
const TOKEN: Record<Chain, string> = { SOL: "simSOL", ETH: "ETH", HYPE: "HYPE" };

/** Won Gemas the Account holds that Instant Redeem could buy: free, still waiting on yield, from a Source the app can pay out. */
export const instantCandidates = (holdings: ChainHolding[]) => holdings.filter((h) => !h.isOwn && h.pending > 0n && (h.native || h.eth));

const holder = (h: ChainHolding) => `Won · ${h.sourceOwner.slice(0, 4)}…${h.sourceOwner.slice(-4)}`;

type InstantPlan = { holding: ChainHolding; line: InstantLine }[];

/** Pays for the won Gemas in order from each treasury's capacity: the SOL treasury vault and the mirrors of the EVM vault treasuries. */
function buildPlan(won: ChainHolding[], market: NativeMarket | null, mirrors: Map<string, VaultTreasuryView> | null) {
  const rates = ratesOf(market?.treasury);
  const caps = new Map<string, bigint>();
  if (market?.treasury && market.treasuryShares !== null) caps.set("SOL", solPayoutCapacity(market.treasuryShares, rateAt(market.pool)));
  for (const [vault, view] of mirrors ?? []) caps.set(vault, view.available);
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
export function useInstantRedeem(): { offer: InstantOffer | null; plan: InstantPlan; freshPlan: (authority: PublicKey) => Promise<InstantPlan> } {
  const { snapshot } = useAccount();
  const market = snapshot?.market ?? null;
  const won = useMemo(() => instantCandidates(snapshot?.holdings ?? []), [snapshot]);
  const vaults = useMemo(() => [...new Set(won.flatMap((h) => (h.eth ? [h.eth.vault.toLowerCase()] : [])))].sort(), [won]);
  const [mirrors, setMirrors] = useState<Map<string, VaultTreasuryView> | null>(null);
  useEffect(() => {
    if (vaults.length === 0) return;
    let stopped = false;
    fetchVaultTreasuries(getChain().base, vaults.map((vault) => ({ vault, eid: netOfVault(vault).eid })))
      .then((m) => !stopped && setMirrors(m))
      .catch(() => !stopped && setMirrors(new Map()));
    return () => {
      stopped = true;
    };
  }, [vaults]);

  /** The plan again from a fresh Account read: a yield crank may have landed since the Player confirmed. */
  const freshPlan = useCallback(
    async (authority: PublicKey) => {
      const fresh = await fetchAccountState(authority, { fresh: true });
      return buildPlan(instantCandidates(fresh.holdings), fresh.market, mirrors).plan;
    },
    [mirrors],
  );

  const view = useMemo(() => {
    if (won.length === 0) return { offer: null, plan: [] };
    const { rates, caps, plan } = buildPlan(won, market, mirrors);
    const rows: InstantRow[] = plan.map(({ holding: h, line }) => ({
      key: line.key,
      asset: h.asset,
      from: holder(h),
      gemas: Number(line.gemas),
      amount: Number(line.payout) / UNITS[h.asset],
      token: TOKEN[h.asset],
      later: !h.native,
    }));
    const assets = [...new Set(won.map((h) => h.asset))];
    const available = assets.map((asset) => {
      const keys = asset === "SOL" ? ["SOL"] : won.filter((h) => h.asset === asset && h.eth).map((h) => h.eth!.vault.toLowerCase());
      const known = keys.filter((k) => caps.has(k));
      return { asset, amount: known.length ? Number(known.reduce((s, k) => s + caps.get(k)!, 0n)) / UNITS[asset] : null, token: TOKEN[asset] };
    });
    const setUp = Boolean(market?.treasury);
    const unavailable = !setUp
      ? "Tesoro has not opened Redeem now yet."
      : rows.length === 0
        ? "Tesoro cannot pay for these Gemas right now. Redeem in full as their yield lands, or try again later."
        : null;
    return { offer: { rows, feePct: rates.instantFeeBps / 100, available, unavailable } as InstantOffer | null, plan };
  }, [won, market, mirrors]);
  return { ...view, freshPlan };
}
