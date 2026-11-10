import { SendTransactionError } from "@solana/web3.js";
import { expect, it, vi } from "vitest";
import { ChainTransactionFailed, sendConfirmed } from "./chain-send";

it.each(["InsufficientFundsForRent", "InsufficientFundsForFee", { InstructionError: [0, { Custom: 6000 }] }])("identifies a finalized atomic rejection: %j", async (err) => {
  const conn = { sendRawTransaction: async () => "sig", getSignatureStatuses: async () => ({ value: [{ err, confirmationStatus: "finalized" }] }) };
  await expect(sendConfirmed(conn as never, new Uint8Array())).rejects.toMatchObject({ beforeBroadcast: false });
});

it("keeps a fork-dependent confirmed failure uncertain until its finalized outcome", async () => {
  vi.useFakeTimers();
  try {
    const getSignatureStatuses = vi.fn()
      .mockResolvedValueOnce({ value: [{ err: "InsufficientFundsForFee", confirmationStatus: "confirmed" }] })
      .mockResolvedValueOnce({ value: [{ err: null, confirmationStatus: "finalized" }] });
    const pending = sendConfirmed({ sendRawTransaction: async () => "sig", getSignatureStatuses } as never, new Uint8Array());
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("sig");
    expect(getSignatureStatuses).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it("identifies a preflight rejection without misclassifying an ambiguous send failure", async () => {
  for (const [err, known] of [
    [new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "InsufficientFundsForFee" }), true],
    [new SendTransactionError({ action: "simulate", signature: "", transactionMessage: "AlreadyProcessed" }), false],
    [new Error("network timeout"), false],
  ] as const) {
    try { await sendConfirmed({ sendRawTransaction: async () => { throw err; } } as never, new Uint8Array()); }
    catch (e) { expect(e instanceof ChainTransactionFailed).toBe(known); }
  }
});

it("failFast: a program error at confirmed throws at once, without waiting for finalized, and is not a settled failure", async () => {
  vi.useFakeTimers();
  try {
    const getSignatureStatuses = vi.fn().mockResolvedValue({ value: [{ err: { InstructionError: [2, { Custom: 2006 }] }, confirmationStatus: "confirmed" }] });
    const pending = sendConfirmed({ sendRawTransaction: async () => "sig", getSignatureStatuses } as never, new Uint8Array(), { failFast: true });
    const settled = expect(pending).rejects.toMatchObject({ beforeBroadcast: false, finalized: false, message: expect.stringContaining("2006") });
    await vi.advanceTimersByTimeAsync(0);
    await settled;
    expect(getSignatureStatuses).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it("failFast does not hurry a fee or balance failure at confirmed: it may still land on the surviving fork", async () => {
  vi.useFakeTimers();
  try {
    const getSignatureStatuses = vi.fn()
      .mockResolvedValueOnce({ value: [{ err: "InsufficientFundsForFee", confirmationStatus: "confirmed" }] })
      .mockResolvedValueOnce({ value: [{ err: null, confirmationStatus: "finalized" }] });
    const pending = sendConfirmed({ sendRawTransaction: async () => "sig", getSignatureStatuses } as never, new Uint8Array(), { failFast: true });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe("sig");
  } finally { vi.useRealTimers(); }
});

it("without failFast a confirmed program error still waits for finalized", async () => {
  vi.useFakeTimers();
  try {
    const getSignatureStatuses = vi.fn()
      .mockResolvedValueOnce({ value: [{ err: { InstructionError: [0, { Custom: 6000 }] }, confirmationStatus: "confirmed" }] })
      .mockResolvedValueOnce({ value: [{ err: { InstructionError: [0, { Custom: 6000 }] }, confirmationStatus: "finalized" }] });
    const pending = sendConfirmed({ sendRawTransaction: async () => "sig", getSignatureStatuses } as never, new Uint8Array());
    const settled = expect(pending).rejects.toMatchObject({ beforeBroadcast: false, finalized: true });
    await vi.runAllTimersAsync();
    await settled;
    expect(getSignatureStatuses).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});

it("a success is returned as soon as it is confirmed, as before", async () => {
  const getSignatureStatuses = vi.fn().mockResolvedValue({ value: [{ err: null, confirmationStatus: "confirmed" }] });
  await expect(sendConfirmed({ sendRawTransaction: async () => "sig", getSignatureStatuses } as never, new Uint8Array(), { failFast: true })).resolves.toBe("sig");
  expect(getSignatureStatuses).toHaveBeenCalledTimes(1);
});
