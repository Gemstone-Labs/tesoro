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
}): Promise<{ ran: boolean; low: number }> {
  const prev = o.load();
  if (prev && o.now - prev.checkedAt < BALANCE_CHECK_EVERY_MS) return { ran: false, low: 0 };
  const manager = o.manager(prev?.manager ?? { open: {}, recovering: {} });
  const low = lowBalances(await readBalances(o.watches, o.read));
  await manager.update(low, o.now);
  o.save({ checkedAt: o.now, manager: manager.state() });
  return { ran: true, low: low.length };
}

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
