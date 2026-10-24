import { createRequire } from "node:module";
import { Keypair } from "@solana/web3.js";
import { expect, it, vi } from "vitest";
import { matchPda, ticketPda } from "./basket";
import { NETS, redeemToEvmIx } from "./eth";
import { instantOrderPda } from "./instant-order";

it("builds entry and cash-out PDAs with Next's actual browser Buffer", () => {
  const browserBuffer = createRequire(import.meta.url)("next/dist/compiled/buffer").Buffer;
  expect(browserBuffer.prototype.writeBigUInt64LE).toBeUndefined();
  const account = Keypair.generate().publicKey;
  const nonce = 0x102030405060708n;
  const before = [matchPda(account, nonce), ticketPda(account, nonce), instantOrderPda(account, nonce)].map((k) => k.toBase58());
  vi.stubGlobal("Buffer", browserBuffer);
  try {
    expect([matchPda(account, nonce), ticketPda(account, nonce), instantOrderPda(account, nonce)].map((k) => k.toBase58())).toEqual(before);
  } finally { vi.unstubAllGlobals(); }
});

it("encodes an EVM payout LineRef with Next's browser Buffer", () => {
  const browserBuffer = createRequire(import.meta.url)("next/dist/compiled/buffer").Buffer;
  const account = Keypair.generate().publicKey;
  const args = [account, account, account, 7n, NETS.hyperevm, { line: { side: 1, dueAt: -123n, class: 0, tranche: 0 }, accounts: [] as import("@solana/web3.js").PublicKey[] }] as const;
  const before = Buffer.from(redeemToEvmIx(...args).data).toString("hex");
  vi.stubGlobal("Buffer", browserBuffer);
  try { expect(redeemToEvmIx(...args).data.toString("hex")).toBe(before); }
  finally { vi.unstubAllGlobals(); }
});
