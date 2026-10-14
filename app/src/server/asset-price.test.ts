import { afterEach, describe, expect, it, vi } from "vitest";
const { assetPrice } = await import("./eth-bridge");

vi.mock("server-only", () => ({}));

const coinbase = (amount: string) => new Response(JSON.stringify({ data: { amount } }));
const coingecko = (id: string, usd: number) => new Response(JSON.stringify({ [id]: { usd } }));

describe("assetPrice", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the last live price when a refresh fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T12:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(coinbase("91.285")));
    expect(await assetPrice("HYPE")).toMatchObject({ microUsd: 91_285_000n, live: true });
    vi.setSystemTime(new Date("2026-10-02T12:02:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")));
    expect(await assetPrice("HYPE")).toMatchObject({ microUsd: 91_285_000n, live: true });
  });

  it("falls back to the display price once the last live one is 10 minutes old", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T13:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(coinbase("90")));
    await assetPrice("ETH");
    vi.setSystemTime(new Date("2026-10-02T13:11:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await assetPrice("ETH")).toMatchObject({ live: false });
  });

  it("reads CoinGecko when Coinbase fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T14:00:00Z"));
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(coingecko("ethereum", 2_450.5));
    vi.stubGlobal("fetch", fetchMock);
    expect(await assetPrice("ETH")).toMatchObject({ microUsd: 2_450_500_000n, live: true });
    expect(String(fetchMock.mock.calls[1][0])).toContain("api.coingecko.com");
  });

  it("ignores a CoinGecko price outside the bounds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T15:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(coingecko("ethereum", 5)));
    expect(await assetPrice("ETH")).toMatchObject({ microUsd: 3_000_000_000n, live: false });
  });

  it("marks the display fallback not live when both sources fail", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T16:00:00Z"));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")));
    expect(await assetPrice("ETH")).toMatchObject({ microUsd: 3_000_000_000n, live: false });
  });

  it("returns CoinGecko's price fast while Coinbase hangs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T17:00:00Z"));
    const fetchMock = vi.fn((url: string) => (url.includes("coinbase") ? new Promise<Response>(() => undefined) : Promise.resolve(coingecko("ethereum", 2_400))));
    vi.stubGlobal("fetch", fetchMock);
    expect(await assetPrice("ETH")).toMatchObject({ microUsd: 2_400_000_000n, live: true });
  });

  it("skips an out-of-bounds first answer for a valid later one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-02T18:00:00Z"));
    vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.includes("coinbase") ? coinbase("5") : coingecko("ethereum", 2_500))));
    expect(await assetPrice("ETH")).toMatchObject({ microUsd: 2_500_000_000n, live: true });
  });
});
