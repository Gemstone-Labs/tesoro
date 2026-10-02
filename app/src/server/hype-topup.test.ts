import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import { HYPE_FUND_AMOUNT, HYPE_RELAYER_MIN, createHypeTopup } from "./hype-topup";
import { DemoHttpError } from "./request-auth";

const A = "0x" + "a".repeat(40);
const B = "0x" + "b".repeat(40);

function setup(over: { balances?: Record<string, bigint>; relayer?: bigint; maxPerHour?: number; sendFails?: boolean; wrongChain?: boolean } = {}) {
  const sent: [string, bigint][] = [];
  const balances = over.balances ?? {};
  const fund = createHypeTopup({
    requireChain: async () => {
      if (over.wrongChain) throw new DemoHttpError(503, "wrong-cluster", "x");
    },
    balanceOf: async (a) => balances[a] ?? 0n,
    relayerBalance: async () => over.relayer ?? parseEther("0.4"),
    send: async (to, v) => {
      if (over.sendFails) throw new Error("rpc down");
      sent.push([to, v]);
      balances[to] = (balances[to] ?? 0n) + v;
      return "0xhash";
    },
    maxPerHour: over.maxPerHour,
  });
  return { fund, sent, balances };
}
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: DemoHttpError) => e.code);

describe("HYPE top-up guards", () => {
  it("drips 0.03 HYPE to an empty wallet and nothing to a funded one", async () => {
    const t = setup({ balances: { [B]: parseEther("0.02") } });
    expect(await t.fund("w1", A, null)).toMatchObject({ funded: true });
    expect(t.sent).toEqual([[A, HYPE_FUND_AMOUNT]]);
    expect(await t.fund("w2", B, null)).toMatchObject({ funded: false });
    expect(t.sent).toHaveLength(1);
  });

  it("once per day per EVM address, Account and user", async () => {
    const t = setup();
    await t.fund("w1", A, "u1");
    t.balances[A] = 0n;
    expect(await code(t.fund("w2", A, "u2"))).toBe("rate-limited");
    expect(await code(t.fund("w1", B, "u3"))).toBe("rate-limited");
    expect(await code(t.fund("w3", B, "u1"))).toBe("rate-limited");
    expect(await code(t.fund("w3", B, "u3"))).toBe("ok");
  });

  it("global hourly cap", async () => {
    const t = setup({ maxPerHour: 2 });
    await t.fund("w1", "0x" + "1".repeat(40), null);
    await t.fund("w2", "0x" + "2".repeat(40), null);
    expect(await code(t.fund("w3", "0x" + "3".repeat(40), null))).toBe("rate-limited");
  });

  it("refuses when the relayer would drop under 0.05 HYPE, and gives the allowance back", async () => {
    const t = setup({ relayer: HYPE_RELAYER_MIN + HYPE_FUND_AMOUNT - 1n });
    expect(await code(t.fund("w1", A, null))).toBe("faucet-empty");
    expect(await code(t.fund("w1", A, null))).toBe("faucet-empty");
    expect(t.sent).toHaveLength(0);
  });

  it("a failed send refunds the allowance", async () => {
    const t = setup({ sendFails: true });
    expect(await code(t.fund("w1", A, null))).toBe("chain");
    expect(await code(t.fund("w1", A, null))).toBe("chain");
  });

  it("rejects malformed addresses and the wrong chain", async () => {
    expect(await code(setup().fund("w", "0x12", null))).toBe("bad-request");
    expect(await code(setup({ wrongChain: true }).fund("w", A, null))).toBe("wrong-cluster");
  });

  it("sends one drip at a time (one relayer nonce)", async () => {
    let active = 0;
    let overlap = false;
    const fund = createHypeTopup({
      requireChain: async () => {},
      balanceOf: async () => 0n,
      relayerBalance: async () => parseEther("1"),
      send: async () => {
        if (++active > 1) overlap = true;
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return "0xhash";
      },
    });
    await Promise.all([fund("w1", "0x" + "1".repeat(40), null), fund("w2", "0x" + "2".repeat(40), null), fund("w3", "0x" + "3".repeat(40), null)]);
    expect(overlap).toBe(false);
  });
});
