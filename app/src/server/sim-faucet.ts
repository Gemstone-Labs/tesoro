/**
 * Server-side simETH / simHYPE faucet: the relayer calls SimLST `faucet(to)` for the Player's EVM address, so the
 * Player signs nothing and needs no gas. The contract already limits each recipient to one claim per cooldown;
 * the guards here keep the relayer from paying gas for claims that would revert or for one caller spamming.
 * The chain and key access are injected so the guards are unit tested (sim-faucet.test.ts).
 */
import { DemoHttpError } from "./request-auth";
import { WindowLimiter, takeAll } from "./rate-limit";

const HOUR = 60 * 60 * 1000;
export const FAUCET_DEFAULT_MAX_PER_HOUR = 30;

export type SimFaucetDeps = {
  /** Throws a DemoHttpError unless the net's RPC is the expected chain. */
  requireChain: (net: string) => Promise<void>;
  /** Unix seconds the faucet is next open for `to` on this token (0 when open now). */
  availableAt: (token: string, to: string, net: string) => Promise<number>;
  /** Sends `faucet(to)` from the relayer; resolves with the tx hash once confirmed. */
  send: (token: string, to: string, net: string) => Promise<string>;
  maxPerHour?: number;
  now?: () => number;
};

export function createSimFaucet(deps: SimFaucetDeps) {
  const perEvm = new WindowLimiter(1, HOUR);
  const perAccount = new WindowLimiter(2, HOUR);
  const perUser = new WindowLimiter(2, HOUR);
  const global = new WindowLimiter(deps.maxPerHour ?? FAUCET_DEFAULT_MAX_PER_HOUR, HOUR);
  const now = deps.now ?? (() => Date.now());

  return async function claim(address: string, evm: string, token: string, net: string, sub: string | null) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(evm)) throw new DemoHttpError(400, "bad-request", "That wallet address doesn’t look right.");
    await deps.requireChain(net);
    const at = await deps.availableAt(token, evm, net);
    if (at * 1000 > now()) throw new DemoHttpError(429, "cooldown", "The faucet is cooling down for this wallet. Try again later.");
    const key = `${net}:${evm.toLowerCase()}`;
    const refund = takeAll([[perEvm, key], [perAccount, address], ...(sub ? ([[perUser, sub]] as const) : []), [global, "all"]]);
    if (!refund) throw new DemoHttpError(429, "rate-limited", "Test token limit reached. Try again in a little while.");
    try {
      return { hash: await deps.send(token, evm, net) };
    } catch {
      refund();
      throw new DemoHttpError(502, "chain", "Getting the test token failed. Try again.");
    }
  };
}
