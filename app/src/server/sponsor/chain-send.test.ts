import { SendTransactionError } from "@solana/web3.js";
import { expect, it } from "vitest";
import { ChainTransactionFailed, sendConfirmed } from "./chain-send";

it.each(["InsufficientFundsForRent", "InsufficientFundsForFee", { InstructionError: [0, { Custom: 6000 }] }])("identifies a confirmed atomic rejection: %j", async (err) => {
  const conn = { sendRawTransaction: async () => "sig", getSignatureStatuses: async () => ({ value: [{ err }] }) };
  await expect(sendConfirmed(conn as never, new Uint8Array())).rejects.toBeInstanceOf(ChainTransactionFailed);
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
