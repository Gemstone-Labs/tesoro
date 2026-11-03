import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AlertManager, readBalances, lowBalances, type ManagerState, type Watch } from "./alerts.ts";

export const BALANCE_CHECK_EVERY_MS = 3_600_000;

export interface BalanceState {
  checkedAt: number;
  manager: ManagerState;
}

/**
 * The hourly low-balance check, run inside the 5-minute safety sweep (no loop of its own). The alert state is saved
 * between runs so a balance that stays low is mailed once, then as a reminder, not every hour.
 */
export async function balanceCheck(o: {
  now: number;
  load: () => BalanceState | null;
  save: (s: BalanceState) => void;
  watches: Watch[];
  read: (w: Watch) => Promise<number>;
  manager: (state: ManagerState) => AlertManager;
  /** Minimum time between reads; hourly by default. */
  everyMs?: number;
}): Promise<{ ran: boolean; low: number }> {
  const prev = o.load();
  if (prev && o.now - prev.checkedAt < (o.everyMs ?? BALANCE_CHECK_EVERY_MS)) return { ran: false, low: 0 };
  const manager = o.manager(prev?.manager ?? { open: {}, recovering: {} });
  const readings = await readBalances(o.watches, o.read);
  const low = lowBalances(readings);
  // A balance that could not be read keeps its open alert: an RPC blip is not a recovery.
  const unread = o.watches.filter((w) => !readings.some((r) => r.key === w.key));
  const carried = unread.flatMap((w) => (prev?.manager.open[w.key] ? [{ key: w.key, title: prev.manager.open[w.key].title, detail: prev.manager.open[w.key].detail }] : []));
  await manager.update([...low, ...carried], o.now);
  o.save({ checkedAt: o.now, manager: manager.state() });
  return { ran: true, low: low.length };
}

/** 1,000 commits at 100,000 lamports each: a failed Sponsor commit reverts the Player's ending move, so it must not run dry. */
export const sponsorMinLamports = (env: NodeJS.ProcessEnv = process.env): number => {
  const v = Number(env.ALERT_MIN_SPONSOR_LAMPORTS);
  return env.ALERT_MIN_SPONSOR_LAMPORTS?.trim() && Number.isFinite(v) ? v : 100_000_000;
};

/** One watch per Game's Sponsor, read on the rollup (net "rollup"; the caller supplies the reader). */
export const sponsorWatches = (games: { label: string; address: string }[], minLamports: number): Watch[] =>
  games.map((g) => ({ key: `balance:sponsor:${g.label}`, label: `${g.label} Sponsor`, unit: "SOL", min: minLamports / 1e9, address: g.address, net: "rollup" }));

/** ALERT_EXTRA_SOL="Duel Fuel=<address>:<min SOL>, ..." adds Solana accounts to watch (Fuel, a Sponsor on the base layer). */
export function extraWatches(env: NodeJS.ProcessEnv = process.env): Watch[] {
  const out: Watch[] = [];
  for (const part of (env.ALERT_EXTRA_SOL ?? "").split(",")) {
    const m = /^\s*([^=]+?)\s*=\s*([1-9A-HJ-NP-Za-km-z]{32,44})\s*:\s*([0-9.]+)\s*$/.exec(part);
    if (m && Number.isFinite(Number(m[3]))) out.push({ key: `balance:extra:${m[1]}`, label: m[1], unit: "SOL", min: Number(m[3]), address: m[2], net: "solana" });
  }
  return out;
}

export const fileBalanceStore = (path: string) => ({
  load: (): BalanceState | null => {
    try {
      return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as BalanceState) : null;
    } catch {
      return null;
    }
  },
  save: (s: BalanceState) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(s));
    renameSync(`${path}.tmp`, path);
  },
});
