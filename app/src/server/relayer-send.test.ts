import { describe, expect, it } from "vitest";
import { isNonceConflict, relayerSend } from "./relayer-send";

const conflict = () => Object.assign(new Error("x"), { shortMessage: "Nonce provided for the transaction is lower than the current nonce" , cause: { message: "nonce too low" } });

describe("nonce conflicts", () => {
  it("classifies node errors", () => {
    expect(isNonceConflict(new Error("nonce too low: next nonce 5"))).toBe(true);
    expect(isNonceConflict(new Error("replacement transaction underpriced"))).toBe(true);
    expect(isNonceConflict(new Error("already known"))).toBe(true);
    expect(isNonceConflict(conflict())).toBe(true);
    expect(isNonceConflict(new Error("insufficient funds"))).toBe(false);
  });

  it("retries a conflict up to 3 attempts and then gives up", async () => {
    let n = 0;
    expect(await relayerSend("t1", async () => (++n < 3 ? Promise.reject(new Error("nonce too low")) : "ok"), 1)).toBe("ok");
    n = 0;
    await expect(relayerSend("t1", async () => (++n, Promise.reject(new Error("already known"))), 1)).rejects.toThrow("already known");
    expect(n).toBe(3);
  });

  it("does not retry other errors", async () => {
    let n = 0;
    await expect(relayerSend("t1", async () => (++n, Promise.reject(new Error("insufficient funds"))), 1)).rejects.toThrow();
    expect(n).toBe(1);
  });

  it("sends one at a time per network", async () => {
    const order: string[] = [];
    const slow = relayerSend("t2", async () => (order.push("a0"), await new Promise((r) => setTimeout(r, 20)), order.push("a1")), 1);
    const fast = relayerSend("t2", async () => void order.push("b"), 1);
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a0", "a1", "b"]);
  });
});
