import { afterEach, describe, expect, it, vi } from "vitest";
const { assetPrice } = await import("./eth-bridge");

vi.mock("server-only", () => ({}));

const coinbase = (amount: string) => new Response(JSON.stringify({ data: { amount } }));

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
});
