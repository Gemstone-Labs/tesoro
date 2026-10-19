import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { relayFailure } = await import("./eth-bridge");
const { ETH_VAULTS } = await import("@/lib/chain/eth");

const vaultOn = (net: string) => ETH_VAULTS.find((v) => v.net === net)!.address;

describe("relayFailure", () => {
  it("names Ethereum for a Hoodi Position and HyperEVM for a HYPE one", () => {
    expect(relayFailure(vaultOn("hoodi"), new Error("boom")).message).toBe("Ethereum Lock step failed.");
    expect(relayFailure(vaultOn("hyperevm"), new Error("boom")).message).toBe("HyperEVM Lock step failed.");
  });
  it("says the network is busy for a transient error, with the right chain", () => {
    const e = relayFailure(vaultOn("hyperevm"), new Error("Request exceeds defined limit."));
    expect(e.status).toBe(503);
    expect(e.message).toMatch(/HyperEVM network is busy/);
    expect(e.message).not.toMatch(/Ethereum/);
    expect(e.message).toBe("The HyperEVM network is busy. Try again in a few seconds.");
  });
});
