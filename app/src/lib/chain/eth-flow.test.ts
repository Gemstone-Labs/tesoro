import { describe, expect, it } from "vitest";
import { ethError } from "./eth-flow";

describe("ethError", () => {
  it("turns public-RPC rate limits and timeouts into a plain retry message", () => {
    const busy = "The network is busy right now. Wait a few seconds and try again.";
    expect(ethError(Object.assign(new Error("x"), { shortMessage: "Request exceeds defined limit." }))).toBe(busy);
    expect(ethError(new Error("The request took too long to respond."))).toBe(busy);
    expect(ethError(new Error("HTTP request failed: rate limited"))).toBe(busy);
  });
  it("keeps other messages", () => {
    expect(ethError(Object.assign(new Error("x"), { shortMessage: "Execution reverted" }))).toBe("Execution reverted");
  });
});
