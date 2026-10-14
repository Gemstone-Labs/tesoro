import { describe, expect, it, vi } from "vitest";
import { isTransient, retryRead, retryingReads } from "./retry";

const noWait = { delayMs: 0 };

describe("isTransient", () => {
  it("accepts rate limits, timeouts and network errors", () => {
    expect(isTransient(new Error("Request exceeds defined limit."))).toBe(true);
    expect(isTransient(new Error("The request took too long to respond."))).toBe(true);
    expect(isTransient(new Error("An unknown RPC error occurred."))).toBe(true);
    expect(isTransient(new Error("fetch failed"))).toBe(true);
    expect(isTransient(Object.assign(new Error("x"), { status: 429 }))).toBe(true);
    expect(isTransient(Object.assign(new Error("x"), { code: -32005 }))).toBe(true);
    expect(isTransient(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransient(new Error("429 Too Many Requests"))).toBe(true);
  });
  it("refuses refusals and program errors", () => {
    expect(isTransient(Object.assign(new Error("Bad request"), { status: 400 }))).toBe(false);
    expect(isTransient(new Error("execution reverted"))).toBe(false);
    expect(isTransient(new Error("custom program error: 0x1771"))).toBe(false);
    expect(isTransient("nope")).toBe(false);
  });
});

describe("retryRead", () => {
  it("retries a transient error and returns the later answer", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("Request exceeds defined limit.")).mockResolvedValue(7);
    await expect(retryRead(read, noWait)).resolves.toBe(7);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("gives up after the tries and throws the last error", async () => {
    const read = vi.fn().mockRejectedValue(new Error("fetch failed"));
    await expect(retryRead(read, { ...noWait, tries: 3 })).rejects.toThrow("fetch failed");
    expect(read).toHaveBeenCalledTimes(3);
  });
  it("does not retry a refusal", async () => {
    const read = vi.fn().mockRejectedValue(Object.assign(new Error("bad"), { status: 400 }));
    await expect(retryRead(read, noWait)).rejects.toThrow("bad");
    expect(read).toHaveBeenCalledTimes(1);
  });
});

describe("retryingReads", () => {
  it("retries read methods only", async () => {
    const getBalance = vi.fn().mockRejectedValueOnce(new Error("fetch failed")).mockResolvedValue(5);
    const sendRawTransaction = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const conn = retryingReads({ getBalance, sendRawTransaction });
    await expect(conn.getBalance()).resolves.toBe(5);
    await expect(conn.sendRawTransaction()).rejects.toThrow("fetch failed");
    expect(sendRawTransaction).toHaveBeenCalledTimes(1);
  });
});
