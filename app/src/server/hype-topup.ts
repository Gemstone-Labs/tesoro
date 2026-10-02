/**
 * HyperEVM testnet HYPE top-up for testers: a small drip from the relayer key when a tester's EVM address is nearly
 * empty. Testnet HYPE has no public faucet (it needs a mainnet balance), so this is the only way a fresh tester gets gas.
 * The guards live here, with the chain and key access injected, so they are unit tested (hype-topup.test.ts).
 */
import { parseEther } from "viem";
import { DemoHttpError } from "./request-auth";
import { WindowLimiter, takeAll } from "./rate-limit";

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export const HYPE_FUND_BELOW = parseEther("0.02");
export const HYPE_FUND_AMOUNT = parseEther("0.03");
/** The relayer never drops under this (the refusal is a clear 503, not a failed send). */
export const HYPE_RELAYER_MIN = parseEther("0.05");
/** Drips per hour, all testers together. `TESORO_HYPE_TOPUP_MAX_PER_HOUR` overrides. */
export const HYPE_DEFAULT_MAX_PER_HOUR = 5;

export type HypeTopupDeps = {
  /** Throws a DemoHttpError unless the RPC is HyperEVM testnet (chain 998). */
  requireChain: () => Promise<void>;
  balanceOf: (address: string) => Promise<bigint>;
  /** Sends `value` wei from the relayer to `to`; resolves with the tx hash once confirmed. */
  send: (to: string, value: bigint) => Promise<string>;
  relayerBalance: () => Promise<bigint>;
  maxPerHour?: number;
};

export function createHypeTopup(deps: HypeTopupDeps) {
  const cost = Number(HYPE_FUND_AMOUNT);
  const perHour = deps.maxPerHour ?? HYPE_DEFAULT_MAX_PER_HOUR;
  // Once per day per EVM address, Account and signed-in user: one drip each.
  const perEvm = new WindowLimiter(cost, DAY);
  const perAccount = new WindowLimiter(cost, DAY);
  const perUser = new WindowLimiter(cost, DAY);
  const global = new WindowLimiter(cost * perHour, HOUR);

  return async function fundHype(address: string, evm: string, sub: string | null) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(evm)) throw new DemoHttpError(400, "bad-request", "Malformed EVM address.");
    await deps.requireChain();
    const balance = await deps.balanceOf(evm);
    if (balance >= HYPE_FUND_BELOW) return { funded: false, balance: balance.toString() };
    const refund = takeAll([[perEvm, evm.toLowerCase()], [perAccount, address], ...(sub ? ([[perUser, sub]] as const) : []), [global, "all"]], cost);
    if (!refund) throw new DemoHttpError(429, "rate-limited", "Test HYPE limit reached. Each wallet gets one top-up per day.");
    try {
      if ((await deps.relayerBalance()) < HYPE_RELAYER_MIN + HYPE_FUND_AMOUNT) {
        refund();
        throw new DemoHttpError(503, "faucet-empty", "The test HYPE faucet is empty. Ask the team to refill it, or send HYPE to your EVM address.");
      }
      const hash = await deps.send(evm, HYPE_FUND_AMOUNT);
      return { funded: true, hash, balance: (balance + HYPE_FUND_AMOUNT).toString() };
    } catch (e) {
      if (e instanceof DemoHttpError) throw e;
      refund();
      throw new DemoHttpError(502, "chain", "HYPE top-up failed. Try again.");
    }
  };
}
