import { CLUSTER } from "@/lib/cluster-settings";
import { ratesOf, planInstant, treasuryBalanceUnits, type InstantCandidate, type InstantLine } from "@/lib/chain/fees";
import { LAMPORTS, SIM_MONTH_MIN, clockOf, nativeNow, rateAt, speedupOf, stakeGrowthOf, unlockEstimateMs, type NativeMarket } from "@/lib/chain/native";
import { unitsForTokens } from "@/lib/chain/stake";
import type { AccountSnapshot, ChainHolding } from "@/lib/chain/read";
import { gemasToUsd } from "@/lib/format";
import { PACK_MONTHS } from "./packs";

/** What the Vault reads of an Account read. */
export type VaultSnapshot = Pick<AccountSnapshot, "positions" | "holdings" | "market">;

const SIM = CLUSTER.yieldModel !== "real";
/** One month on this cluster's clock: 10 minutes in test mode. */
export const monthMs = (): number => (SIM ? SIM_MONTH_MIN * 60_000 : (365.25 / 12) * 86_400_000);

export type DepositState = "growing" | "ready" | "late";

export interface DepositRow {
  /** The Lock's address: what withdrawing it needs. */
  id: string;
  /** "Deposit 1": numbered in the order they were read, withdrawn ones included, so numbers don't shift. */
  label: string;
  sol: number;
  /** What the SOL is worth at today's price; null while there is no price. */
  worthUsd: number | null;
  /** Gemas it gave when it was made. */
  gemasGiven: number | null;
  state: DepositState;
  /** When it should be ready, ms: null when nothing can be projected. */
  backAtMs: number | null;
}

export interface Winnings {
  /** Won Gemas that cash out for free right now. */
  readyNow: number;
  readyNowUsd: number;
  /** Won Gemas still waiting for the deposits behind them to earn. */
  readyLater: number;
  /** A rough date for the next ones: the soonest of your own deposits (the Wallet's estimate); null when unknown. */
  readyLaterAtMs: number | null;
  /** Cash out now: sell the waiting ones to Tesoro at a cost. Null when nothing is waiting or Tesoro can't pay right now. */
  instant: { gemas: number; usd: number; keepPct: number } | null;
}

export interface VaultView {
  /** Gemas playable now. */
  gemas: number;
  deposits: DepositRow[];
  withdrawn: number;
  /** Locks on Ethereum or HyperEVM: only the Advanced view manages them. */
  otherChainDeposits: boolean;
  /** Won Gemas from Ethereum or HyperEVM Sources. */
  otherChainWinnings: boolean;
  winnings: Winnings;
  /** Nothing yet: no deposits, no Gemas, no winnings. */
  isNew: boolean;
}

const isWon = (h: ChainHolding) => !h.isOwn && h.native;

/** Won Gemas the Treasury could buy: free, still waiting for yield, from a Solana-native Source. */
export const instantCandidatesSol = (holdings: ChainHolding[]) => holdings.filter((h) => isWon(h) && h.pending > 0n);

/** The most the Treasury can pay out right now in SOL units, or null while there is no Treasury. */
function treasuryCap(market: NativeMarket | null, nowSec: number): bigint | null {
  if (!market?.treasury) return null;
  if (market.stake?.treasuryTokens != null) return unitsForTokens(market.stake.treasuryTokens, market.stake.rate);
  if (market.treasuryShares !== null && market.treasuryClaim) {
    return treasuryBalanceUnits({ ...market.treasuryClaim, vaultShares: market.treasuryShares, rate: rateAt(market.pool), speedup: speedupOf(market.pool), nowSec });
  }
  return null;
}

/** What "Cash out now" would sell, in order, until the Treasury can pay no more. */
export function planCashOutNow(holdings: ChainHolding[], market: NativeMarket | null, nowSec: number): { holding: ChainHolding; line: InstantLine }[] {
  const cap = treasuryCap(market, nowSec);
  if (cap === null) return [];
  const won = instantCandidatesSol(holdings);
  const candidates: InstantCandidate[] = won.map((h) => ({ key: h.holding.toBase58(), capKey: "SOL", free: h.pending, unitNum: h.unitNum, unitDen: h.unitDen }));
  const byKey = new Map(won.map((h) => [h.holding.toBase58(), h]));
  return planInstant(candidates, new Map([["SOL", cap]]), ratesOf(market?.treasury).instantFeeBps).map((line) => ({ holding: byKey.get(line.key)!, line }));
}

export function vaultView({ snapshot, gemasAvailable, nowMs }: { snapshot: VaultSnapshot | null; gemasAvailable: number; nowMs: number }): VaultView {
  const positions = snapshot?.positions ?? [];
  const holdings = snapshot?.holdings ?? [];
  const market = snapshot?.market ?? null;
  const nowSec = Math.floor(nowMs / 1000);
  const speedup = speedupOf(market?.pool);
  const stake = stakeGrowthOf(market, nowSec);
  const priceUsd = market?.price ? Number(market.price.microUsd) / 1e6 : null;

  const deposits: DepositRow[] = [];
  let withdrawn = 0;
  let n = 0;
  const unlockTimes: number[] = [];
  for (const p of positions) {
    const info = p.native;
    if (!info) continue;
    n += 1;
    if (info.status !== "locked") {
      withdrawn += 1;
      continue;
    }
    const cur = nativeNow(info, speedup, nowSec, stake);
    const sol = Number(info.principalLamports) / LAMPORTS;
    const ready = cur.debtGemas === 0n;
    const estimate = !ready && cur.source ? unlockEstimateMs({ clock: clockOf(info), speedup, appliedNet: info.appliedNet, source: cur.source, nowMs, stake }) : null;
    if (estimate !== null) unlockTimes.push(estimate);
    const dueMs = info.openedAt * 1000 + PACK_MONTHS * monthMs();
    deposits.push({
      id: p.address.toBase58(),
      label: `Deposit ${n}`,
      sol,
      worthUsd: priceUsd === null ? null : sol * priceUsd,
      gemasGiven: info.source ? Number(info.source.math.issued) : null,
      state: ready ? "ready" : nowMs >= dueMs ? "late" : "growing",
      backAtMs: ready ? null : estimate,
    });
  }

  const won = holdings.filter(isWon);
  const readyNow = won.reduce((t, h) => t + Number(h.redeemable), 0);
  const readyLater = won.reduce((t, h) => t + Number(h.pending), 0);
  const plan = planCashOutNow(holdings, market, nowSec);
  const instantGemas = plan.reduce((t, p) => t + Number(p.line.gemas), 0);
  const keepPct = 100 - ratesOf(market?.treasury).instantFeeBps / 100;

  return {
    gemas: gemasAvailable,
    deposits,
    withdrawn,
    otherChainDeposits: positions.some((p) => !p.native && p.eth !== null),
    otherChainWinnings: holdings.some((h) => !h.isOwn && !h.native && h.eth !== null && h.amount > 0n),
    winnings: {
      readyNow,
      readyNowUsd: gemasToUsd(readyNow),
      readyLater,
      readyLaterAtMs: readyLater > 0 && unlockTimes.length ? Math.min(...unlockTimes) : null,
      instant: instantGemas > 0 ? { gemas: instantGemas, usd: (gemasToUsd(instantGemas) * keepPct) / 100, keepPct } : null,
    },
    isNew: deposits.length === 0 && withdrawn === 0 && gemasAvailable === 0 && readyNow === 0 && readyLater === 0 && !positions.some((p) => p.eth),
  };
}

const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });
const DAY_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/** "October 2027": when a deposit should come back. Test mode runs 12 months in about two hours, so it says the day and time. */
export const fmtBackAt = (ms: number): string => (SIM ? DAY_TIME.format(ms) : MONTH_YEAR.format(ms));
