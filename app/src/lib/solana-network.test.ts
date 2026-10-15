import { describe, expect, it } from "vitest";
import { solanaNetwork } from "./solana-network";

describe("solanaNetwork", () => {
  it("test mode is devnet whatever the browser RPC is", () => {
    expect(solanaNetwork("test", undefined)).toMatchObject({ key: "solana:devnet", rpc: "https://api.devnet.solana.com" });
  });
  it("mainnet uses the browser RPC and derives the socket", () => {
    expect(solanaNetwork("mainnet", "https://mainnet.helius-rpc.com/?api-key=x")).toEqual({
      key: "solana:mainnet",
      rpc: "https://mainnet.helius-rpc.com/?api-key=x",
      ws: "wss://mainnet.helius-rpc.com/?api-key=x",
    });
  });
  it("mainnet without a browser RPC throws", () => {
    expect(() => solanaNetwork("mainnet", undefined)).toThrow(/NEXT_PUBLIC_SOLANA_RPC/);
  });
});
