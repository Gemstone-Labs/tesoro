"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "@/lib/account";
import { getChain } from "@/lib/chain/client";
import { fetchAccountState } from "@/lib/chain/read";
import { fetchVaultTreasuries } from "@/lib/chain/treasury";
import { fetchLiveTreasury, netOfVault } from "@/lib/chain/eth";
import { INSTANT_NOT_OPEN, instantPayoutFor, instantTryCap, ratesOf, type VaultTreasuryView } from "@/lib/chain/fees";
import { INSTANT_REDEEM_FEE_BPS, fetchInstantOrders, orderState, type InstantOrder } from "@/lib/chain/instant-order";
import { LAMPORTS, rateAt, type NativeMarket } from "@/lib/chain/native";
import { unitsForTokens } from "@/lib/chain/stake";
import type { ChainHolding } from "@/lib/chain/read";
import type { PublicKey } from "@solana/web3.js";
import type { Chain } from "@/lib/mock";
import type { InstantOffer, InstantRow, OpenOrderRow } from "./MoneySheets";

const UNITS: Record<Chain, number> = { SOL: LAMPORTS, ETH: 1e18, HYPE: 1e18 };
const TOKEN: Record<Chain, string> = { SOL: "test SOL", ETH: "ETH", HYPE: "HYPE" };

/**
 * Gemas the Account holds, won or own (founder, 2026-10-22), that an Instant Redeem order could offer: still waiting on yield, from a
 * Source the app can sell. An ETH or HYPE Source cannot start an order while some of its Gemas are already redeemable (the bridge
 * pays those through a Redeem).
 */
export const instantCandidates = (holdings: ChainHolding[]) =>
  holdings.filter((h) => h.classId >= 3 && h.pending > 0n && (h.native || (h.eth && h.redeemable === 0n)));

const holder = (h: ChainHolding) => (h.isOwn ? `Your ${h.asset} deposit` : `Won · ${h.sourceOwner.slice(0, 4)}…${h.sourceOwner.slice(-4)}`);

/** One line "Redeem now" offers: the holding and the Gemas it puts in an order (all that is pending). */
export type InstantPlan = { holding: ChainHolding; gemas: bigint; payout: bigint }[];

/** Source-asset units a Treasury with `spendable` shares can pay, for the "most Tesoro can pay right now" line. */
function capacities(market: NativeMarket | null, mirrors: Map<string, VaultTreasuryView> | null, live: Map<string, bigint> | null) {
  const caps = new Map<string, bigint>();
  const route = market?.treasuryRoute;
  if (market?.stake && route) caps.set("SOL", unitsForTokens(route.spendable, market.stake.rate));
  else if (market && route) caps.set("SOL", (route.spendable * rateAt(market.pool)) / 1_000_000_000n);
  for (const [vault, view] of mirrors ?? []) caps.set(vault, instantTryCap(view, live?.get(vault) ?? null));
  return caps;
}

/** What each holding's pending Gemas pay now: their value after the Source's Yield Fee and the Instant Redeem Fee (one floor, as on chain). */
function buildPlan(sellable: ChainHolding[], bps: number): InstantPlan {
  return sellable.map((h) => ({ holding: h, gemas: h.pending, payout: instantPayoutFor(h, h.pending, bps, h.yieldFeeBps) })).filter((p) => p.payout > 0n);
}

/**
 * The Instant Redeem side of the Redeem sheet, from the Account's snapshot: the order "Redeem now" would put in for every line (won or own) that
 * is waiting on yield, what Tesoro would pay for it, and the orders already waiting. Null when the Account holds nothing to sell and has no orders.
 * Selling is a request: Tesoro buys when it can fill it, all or part, and the rest comes back on cancel or after the deadline.
 */
export function useInstantRedeem(asset?: Chain): { offer: InstantOffer | null; plan: InstantPlan; orders: InstantOrder[]; behind: Set<string>; freshPlan: (authority: PublicKey) => Promise<InstantPlan>; reloadOrders: () => Promise<void> } {
  const { snapshot } = useAccount();
  const market = snapshot?.market ?? null;
  const sellable = useMemo(() => instantCandidates(snapshot?.holdings ?? []).filter((h) => !asset || h.asset === asset), [snapshot, asset]);
  const vaults = useMemo(() => [...new Set(sellable.flatMap((h) => (h.eth ? [h.eth.vault.toLowerCase()] : [])))].sort(), [sellable]);
  const [mirrors, setMirrors] = useState<Map<string, VaultTreasuryView> | null>(null);
  const [live, setLive] = useState<Map<string, bigint> | null>(null);
  const [orders, setOrders] = useState<InstantOrder[]>([]);
  const accountKey = snapshot?.accountKey ?? null;
  const reloadOrders = useCallback(async () => {
    if (!accountKey) return;
    setOrders(await fetchInstantOrders(accountKey).catch(() => []));
  }, [accountKey]);
  useEffect(() => {
    if (!accountKey) return;
    let stopped = false;
    fetchInstantOrders(accountKey)
      .then((o) => !stopped && setOrders(o))
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [accountKey, snapshot?.fetchedAt]);
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

  /** The plan again from a fresh Account read: yield may have landed since the Player opened the sheet. */
  const freshPlan = useCallback(
    async (authority: PublicKey) => {
      const fresh = await fetchAccountState(authority, { fresh: true });
      return buildPlan(instantCandidates(fresh.holdings).filter((h) => !asset || h.asset === asset), INSTANT_REDEEM_FEE_BPS);
    },
    [asset],
  );

  const view = useMemo((): { offer: InstantOffer | null; plan: InstantPlan } => {
    const nowSec = Math.floor((snapshot?.fetchedAt ?? 0) / 1000);
    const open: OpenOrderRow[] = orders.map((o) => ({ key: o.address.toBase58(), gemas: Number(o.line.amount), sold: Number(o.sold), expiresAt: o.expiresAt * 1000, state: orderState(o, nowSec) as OpenOrderRow["state"] }));
    if (sellable.length === 0 && open.length === 0) return { offer: null, plan: [] };
    // The program charges its flat Instant Redeem Fee (ledger `instant_fee_bps`), whatever the Treasury account's field says.
    const bps = INSTANT_REDEEM_FEE_BPS;
    const plan = buildPlan(sellable, bps);
    const caps = capacities(market, mirrors, live);
    const rows: InstantRow[] = plan.map(({ holding: h, gemas, payout }) => ({
      key: h.key,
      asset: h.asset,
      from: holder(h),
      gemas: Number(gemas),
      amount: Number(payout) / UNITS[h.asset],
      token: h.stakeMint && market?.stake ? market.stake.token.symbol : TOKEN[h.asset],
      later: !h.native,
      yieldFeeBps: h.yieldFeeBps,
    }));
    const assets = [...new Set(sellable.map((h) => h.asset))];
    const available = assets.map((a) => {
      const keys = a === "SOL" ? ["SOL"] : sellable.filter((h) => h.asset === a && h.eth).map((h) => h.eth!.vault.toLowerCase());
      const known = keys.filter((k) => caps.has(k));
      return { asset: a, amount: known.length ? Number(known.reduce((sum, k) => sum + caps.get(k)!, 0n)) / UNITS[a] : null, token: a === "SOL" && market?.stake ? market.stake.token.symbol : TOKEN[a] };
    });
    const unavailable = market?.treasury ? null : INSTANT_NOT_OPEN;
    const yieldFeePct = (sellable[0]?.yieldFeeBps ?? ratesOf(market?.treasury).yieldFeeBps) / 100;
    return { offer: { rows, feePct: bps / 100, yieldFeePct, available, unavailable, fetchesYield: false, orders: open }, plan };
  }, [sellable, market, mirrors, live, orders, snapshot?.fetchedAt]);
  /** Vaults whose own Treasury holds more than the bridge's mirror shows. */
  const behind = useMemo(() => new Set([...(mirrors ?? [])].filter(([v, m]) => (live?.get(v) ?? 0n) > m.balance).map(([v]) => v)), [mirrors, live]);
  return { ...view, orders, behind, freshPlan, reloadOrders };
}
