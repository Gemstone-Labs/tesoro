import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import idl from "./idl/tesoro_core.json";
import { CORE_PROGRAM_ID, coreIx } from "./core-ix";

const k = () => Keypair.generate().publicKey;

describe("coreIx", () => {
  it("orders accounts and sets flags from the IDL, and encodes arguments with the discriminator", () => {
    const ix = coreIx("request_instant_redeem", { payer: k(), holder_authority: k(), holder_account: k(), basket: k(), spill: k(), position: k(), source: k(), order: k() }, { line: { side: 1, due_at: 5n, class: 3, tranche: 0 }, sell: 7n, ttl_secs: 60n, nonce: 1n });
    const spec = (idl.instructions as { name: string; discriminator: number[]; accounts: { writable?: boolean; signer?: boolean; optional?: boolean }[] }[]).find((i) => i.name === "request_instant_redeem")!;
    expect(ix.keys).toHaveLength(spec.accounts.length);
    spec.accounts.forEach((a, i) => {
      if (a.optional) return;
      expect(ix.keys[i].isWritable).toBe(!!a.writable);
      expect(ix.keys[i].isSigner).toBe(!!a.signer);
    });
    expect([...ix.data.subarray(0, 8)]).toEqual(spec.discriminator);
    // 8 disc + line (1 + 8 + 1 + 1) + sell + ttl + nonce
    expect(ix.data).toHaveLength(8 + 11 + 24);
  });

  it("stands the program id in for an optional account left out, never as signer or writable", () => {
    const ix = coreIx("cancel_instant_redeem", { signer: k(), owner_account: k(), basket: k(), spill: k(), order: k(), owner_wallet: k(), sponsor: null });
    const last = ix.keys.at(-1)!;
    expect(last.pubkey.equals(CORE_PROGRAM_ID)).toBe(true);
    expect([last.isSigner, last.isWritable]).toEqual([false, false]);
  });

  it("refuses a missing or unknown account by name", () => {
    expect(() => coreIx("unlock", { owner_authority: k() })).toThrow(/owner_account is missing/);
    expect(() => coreIx("unlock", { owner_authority: k(), owner_account: k(), economy: k(), position: k(), nope: k() })).toThrow(/no account nope/);
    expect(() => coreIx("nope", {})).toThrow(/no instruction/);
  });

  it("appends remaining accounts after the IDL's", () => {
    const extra = { pubkey: PublicKey.default, isSigner: false, isWritable: true };
    const ix = coreIx("unlock", { owner_authority: k(), owner_account: k(), economy: k(), position: k() }, {}, [extra]);
    expect(ix.keys).toHaveLength(5);
    expect(ix.keys[4]).toEqual(extra);
  });
});
