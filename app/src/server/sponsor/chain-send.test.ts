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
