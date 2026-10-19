import { DemoHttpError } from "./request-auth";

/** A Position's report is not asked for again until this long has passed, or the first one has landed on Solana. */
export const REPORT_COOLDOWN_MS = 60_000;

export interface YieldReportDeps {
  requireChain: (vault: string) => Promise<void>;
  /** The vault's own record of the Position; null when it does not exist. */
  vaultPosition: (vault: string, id: bigint) => Promise<{ unlocked: boolean } | null>;
  /** The latest Yield Report sequence the bridge has received for the Position (0 before any). */
  lastYieldSeq: (vault: string, id: bigint) => Promise<bigint>;
  /** `quoteYieldAccrued()` plus headroom. */
  fee: (vault: string) => Promise<bigint>;
  /** Calls `reportYield(id)` from the relayer's EVM key and returns the transaction hash. */
  send: (vault: string, id: bigint, value: bigint) => Promise<string>;
  now?: () => number;
}

/**
 * Test mode only: the relayer's EVM key asks the vault to report a Position's yield so the Player needs no EVM wallet.
 * Anyone may ask and the content cannot be altered, so this is a convenience. One request per Position per minute, and
 * not while the previous one is still crossing chains, so it cannot drain the relayer's gas.
 */
export function createYieldReporter(deps: YieldReportDeps) {
  const recent = new Map<string, { at: number; seq: bigint }>();
  const now = deps.now ?? Date.now;
  return async function reportYield(vault: string, id: bigint): Promise<{ hash: string }> {
    await deps.requireChain(vault);
    const position = await deps.vaultPosition(vault, id);
    if (!position) throw new DemoHttpError(404, "no-lock", "That Lock does not exist.");
    if (position.unlocked) throw new DemoHttpError(409, "unlocked", "That Lock is already unlocked.");
    const key = `${vault.toLowerCase()}:${id}`;
    const seq = await deps.lastYieldSeq(vault, id);
    const last = recent.get(key);
    if (last && now() - last.at < REPORT_COOLDOWN_MS && seq <= last.seq) {
      throw new DemoHttpError(409, "report-pending", "The latest yield is already on its way. Give it a minute or two.");
    }
    recent.set(key, { at: now(), seq });
    try {
      return { hash: await deps.send(vault, id, await deps.fee(vault)) };
    } catch (e) {
      recent.delete(key);
      throw e;
    }
  };
}
