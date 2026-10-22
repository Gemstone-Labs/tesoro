import { CLUSTER } from "@/lib/cluster-settings";
import { LAMPORTS, SIM_MONTH_MIN, clockOf, nativeNow, speedupOf, stakeGrowthOf, unlockEstimateMs } from "@/lib/chain/native";
import type { AccountSnapshot } from "@/lib/chain/read";
import { DEPOSIT_PACKS, PACK_MONTHS, type DepositPackId } from "./packs";

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
  /** When it was made, ms. */
  openedAtMs: number;
}

export interface VaultView {
  /** Gemas playable now. */
  gemas: number;
  deposits: DepositRow[];
  withdrawn: number;
  /** Locks on Ethereum or HyperEVM: only the Advanced view manages them. */
  otherChainDeposits: boolean;
  /** Nothing yet: no deposits and no Gemas. */
  isNew: boolean;
}

export function vaultView({ snapshot, gemasAvailable, gemasTotal, nowMs }: { snapshot: VaultSnapshot | null; gemasAvailable: number; gemasTotal?: number; nowMs: number }): VaultView {
  const positions = snapshot?.positions ?? [];
  const market = snapshot?.market ?? null;
  const nowSec = Math.floor(nowMs / 1000);
  const speedup = speedupOf(market?.pool);
  const stake = stakeGrowthOf(market, nowSec);
  const priceUsd = market?.price ? Number(market.price.microUsd) / 1e6 : null;

  const deposits: DepositRow[] = [];
  let withdrawn = 0;
  let n = 0;
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
    const dueMs = info.openedAt * 1000 + PACK_MONTHS * monthMs();
    deposits.push({
      id: p.address.toBase58(),
      label: `Deposit ${n}`,
      sol,
      worthUsd: priceUsd === null ? null : sol * priceUsd,
      gemasGiven: info.source ? Number(info.source.math.issued) : null,
      state: ready ? "ready" : nowMs >= dueMs ? "late" : "growing",
      backAtMs: ready ? null : estimate,
      openedAtMs: info.openedAt * 1000,
    });
  }

  return {
    gemas: gemasAvailable,
    deposits,
    withdrawn,
    otherChainDeposits: positions.some((p) => !p.native && p.eth !== null),
    isNew: deposits.length === 0 && withdrawn === 0 && gemasAvailable === 0 && (gemasTotal ?? 0) === 0 && !positions.some((p) => p.eth),
  };
}

const MONTH_YEAR = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" });
const DAY_TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

/** "October 2027": when a deposit should come back. Test mode runs 12 months in about two hours, so it says the day and time. */
export const fmtBackAt = (ms: number): string => (SIM ? DAY_TIME.format(ms) : MONTH_YEAR.format(ms));

/** How far a deposit is on its way back, 0 to 1: from the day it was made to its date back (its 12 months when it has none). */
export function depositProgress(d: Pick<DepositRow, "state" | "openedAtMs" | "backAtMs">, nowMs: number): number {
  if (d.state !== "growing") return 1;
  const span = (d.backAtMs ?? d.openedAtMs + PACK_MONTHS * monthMs()) - d.openedAtMs;
  return span <= 0 ? 1 : Math.min(1, Math.max(0, (nowMs - d.openedAtMs) / span));
}

const two = (n: number) => String(n).padStart(2, "0");

/** "47m 12s", "3h 05m", "12 days", "4 months": the time left before a deposit comes back. */
export function fmtTimeLeft(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86_400);
  if (days >= 60) return `${Math.round(days / 30.4)} months`;
  if (days >= 2) return `${days} days`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${two(m)}m`;
  return m > 0 ? `${m}m ${two(s % 60)}s` : `${s % 60}s`;
}

/** The pack a deposit most likely was, for its art: the one priced nearest its value today (deposits don't record their pack). */
export function likelyPack(worthUsd: number | null): DepositPackId {
  if (worthUsd === null) return "player";
  return DEPOSIT_PACKS.reduce((best, p) => (Math.abs(p.usd - worthUsd) < Math.abs(best.usd - worthUsd) ? p : best)).id;
}
