import { describe, expect, it } from "vitest";
import { launchStageOf } from "./config";

describe("launchStageOf", () => {
  it("follows the cluster", () => {
    expect(launchStageOf(undefined, "test")).toBe("testnet");
    expect(launchStageOf(undefined, "mainnet")).toBe("mainnet");
  });
  it("lets the override win", () => {
    expect(launchStageOf("testnet", "mainnet")).toBe("testnet");
    expect(launchStageOf("mainnet", "test")).toBe("mainnet");
    expect(launchStageOf("bogus", "test")).toBe("testnet");
  });
});
