import { describe, expect, it } from "vitest";
import { buildEthVaults, fetchEthMarket, ethUnlockEstimateMs, KHYPE_TOKEN, WSTETH_TOKEN, type EthVault, type MarketClient } from "./eth";

const WSTETH_VAULT = "0x1111111111111111111111111111111111111111";
const LIDO_ZAP = "0x2222222222222222222222222222222222222222";
const KHYPE_VAULT = "0x3333333333333333333333333333333333333333";
const ADAPTER = "0x4444444444444444444444444444444444444444";
const OWNER = "0x5555555555555555555555555555555555555555";

describe("vaults per cluster", () => {
  it("test mode lists the two SimLST vaults only", () => {
    const v = buildEthVaults("test", { wstethVault: WSTETH_VAULT, khypeVault: KHYPE_VAULT });
    expect(v.map((x) => x.key)).toEqual(["sim", "sim-hype"]);
    expect(v.every((x) => x.simulated)).toBe(true);
  });

  it("mainnet lists nothing simulated, and nothing until an address is set", () => {
    expect(buildEthVaults("mainnet", {})).toEqual([]);
    expect(buildEthVaults("mainnet", { wstethVault: "not an address", khypeVault: "" })).toEqual([]);
  });

  it("mainnet lists the wstETH vault on Ethereum with its zap and the kHYPE vault on HyperEVM", () => {
    const v = buildEthVaults("mainnet", { wstethVault: WSTETH_VAULT, lidoZap: LIDO_ZAP, khypeVault: KHYPE_VAULT });
    expect(v).toEqual([
      expect.objectContaining({ key: "wsteth", net: "hoodi", address: WSTETH_VAULT, lst: WSTETH_TOKEN, symbol: "wstETH", simulated: false, zap: LIDO_ZAP }),
      expect.objectContaining({ key: "khype", net: "hyperevm", address: KHYPE_VAULT, lst: KHYPE_TOKEN, symbol: "kHYPE", simulated: false, zap: undefined }),
    ]);
  });

  it("an invalid zap address leaves the token path only", () => {
    expect(buildEthVaults("mainnet", { wstethVault: WSTETH_VAULT, lidoZap: "nope" })[0].zap).toBeUndefined();
  });
});

const realVault: EthVault = { key: "wsteth", net: "hoodi", label: "wstETH", address: WSTETH_VAULT, lst: WSTETH_TOKEN, symbol: "wstETH", simulated: false };

/** A client that answers by function name and throws on anything a real-token vault does not have. */
function fakeClient(answers: Record<string, unknown>, calls: string[] = []): MarketClient {
  return {
    readContract: (async ({ functionName }: { functionName: string }) => {
      calls.push(functionName);
      if (!(functionName in answers)) throw new Error(`no such function: ${functionName}`);
      return answers[functionName];
    }) as never,
    getBalance: (async () => 7n * 10n ** 17n) as never,
  };
}

describe("market read on a rate-based vault", () => {
  const answers = {
    balanceOf: 3n * 10n ** 18n,
    allowance: 0n,
    quotePositionLocked: 10n ** 15n,
    quoteYieldAccrued: 2n * 10n ** 15n,
    nextPositionId: 5n,
    rateSource: ADAPTER,
    underlyingPerShare: 1_200_000_000_000_000_000n,
  };

  it("reads the rate from the rate source and never touches SimLST-only fields", async () => {
    const calls: string[] = [];
    const m = await fetchEthMarket(realVault, OWNER, fakeClient(answers, calls));
    expect(calls).not.toContain("faucetAmount");
    expect(calls).not.toContain("baseRate");
    expect(m.rate.baseRate).toBe(1_200_000_000_000_000_000n);
    expect(m.rate.speedup).toBe(1n);
    expect(m.simEth).toBe(3n * 10n ** 18n);
    expect(m.ethBalance).toBe(7n * 10n ** 17n);
    expect(m.quoteOpen).toBe(10n ** 15n);
    expect(m.nextPositionId).toBe(5n);
    expect(m.faucetAvailableAt).toBe(0);
  });

  it("has no APY until the trailing figure is published", async () => {
    expect((await fetchEthMarket(realVault, OWNER, fakeClient(answers))).apyBps).toBeNull();
  });
});

describe("market read on a SimLST vault (test mode unchanged)", () => {
  it("reads the configured APY and the faucet", async () => {
    const sim: EthVault = { ...realVault, key: "sim", simulated: true };
    const m = await fetchEthMarket(
      sim,
      OWNER,
      fakeClient({ balanceOf: 1n, allowance: 2n, quotePositionLocked: 3n, quoteYieldAccrued: 4n, nextPositionId: 5n, baseRate: 10n ** 18n, baseTime: 100n, apyBps: 500n, speedup: 4380n, faucetAmount: 10n, faucetCooldown: 3600n, lastFaucet: 1000n }),
    );
    expect(m.apyBps).toBe(500n);
    expect(m.faucetAvailableAt).toBe(4600);
    expect(m.rate.speedup).toBe(4380n);
  });
});

describe("unlock estimate on a real-token vault", () => {
  it("runs on the Position's recorded APY at real speed", () => {
    const source = { issued: 100n, returned: 0n, redeemed: 0n, yieldUnits: 0n, unitNum: 10n ** 22n, unitDen: 3_000_000_000n };
    const position = { heldShares: 10n ** 18n, principalUnderlying: 10n ** 18n, paidUnderlying: 0n, accrued: 0n };
    const at = ethUnlockEstimateMs({ source, position, rate: { baseRate: 10n ** 18n, baseTime: 0n, apyBps: 400n, speedup: 1n }, nowMs: 0 });
    expect(at).not.toBeNull();
    const noApy = ethUnlockEstimateMs({ source, position, rate: { baseRate: 10n ** 18n, baseTime: 0n, apyBps: 0n, speedup: 1n }, nowMs: 0 });
    expect(noApy).toBeNull();
  });
});
