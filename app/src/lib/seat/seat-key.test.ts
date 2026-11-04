import { Keypair, MessageV0, PublicKey, SystemProgram, Transaction, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { SeatKeyManager, memorySeatKeyStore, signInto } from "./seat-key";
import { matchAddressOf } from "@/lib/chain/match-id";

const wallet = Keypair.generate().publicKey;
const opener = Keypair.generate().publicKey.toBase58();
const matchKey = `${opener}-7`;
const verify = (key: PublicKey, message: Uint8Array, sig: Uint8Array) => nacl.sign.detached.verify(message, sig, key.toBytes());

describe("seat key manager", () => {
  it("makes a non-extractable WebCrypto Ed25519 key per Match that signs for its public key", async () => {
    const m = new SeatKeyManager({ store: memorySeatKeyStore() });
    const k = await m.forMatch(matchKey, wallet);
    expect(k.kind).toBe("webcrypto");
    expect(k.wallet.equals(wallet)).toBe(true);
    expect(k.seatMatch.equals(matchAddressOf(matchKey)!)).toBe(true);
    const msg = new TextEncoder().encode("hello");
    expect(verify(k.publicKey, msg, await k.signMessage(msg))).toBe(true);
    // the private key cannot be read out
    const stored = (await (m as unknown as { store: ReturnType<typeof memorySeatKeyStore> }).store.get(matchKey))!;
    expect((stored.secret as CryptoKey).extractable).toBe(false);
  });

  it("keeps the same key across a reload (a new manager over the same store) and for repeated asks", async () => {
    const store = memorySeatKeyStore();
    const first = await new SeatKeyManager({ store }).forMatch(matchKey, wallet);
    const again = await new SeatKeyManager({ store }).forMatch(matchKey, wallet);
    expect(again.publicKey.equals(first.publicKey)).toBe(true);
    const msg = new Uint8Array([1, 2, 3]);
    expect(verify(first.publicKey, msg, await again.signMessage(msg))).toBe(true);
    const m = new SeatKeyManager({ store });
    const [a, b] = await Promise.all([m.forMatch(`${opener}-8`, wallet), m.forMatch(`${opener}-8`, wallet)]);
    expect(a.publicKey.equals(b.publicKey)).toBe(true);
  });

  it("keeps a different key for each Match", async () => {
    const m = new SeatKeyManager({ store: memorySeatKeyStore() });
    const a = await m.forMatch(`${opener}-1`, wallet);
    const b = await m.forMatch(`${opener}-2`, wallet);
    expect(a.publicKey.equals(b.publicKey)).toBe(false);
  });

  it("does not hand the key to another wallet on the same device", async () => {
    const m = new SeatKeyManager({ store: memorySeatKeyStore() });
    await m.forMatch(matchKey, wallet);
    expect(await m.find(matchKey, Keypair.generate().publicKey)).toBeNull();
    expect(await m.find(matchKey, wallet)).not.toBeNull();
  });

  it("is deleted when the Match closes", async () => {
    const m = new SeatKeyManager({ store: memorySeatKeyStore() });
    await m.forMatch(matchKey, wallet);
    await m.release(matchKey);
    expect(await m.find(matchKey, wallet)).toBeNull();
    expect(await m.held()).toEqual([]);
  });

  it("falls back to a software key where the browser has no Ed25519, and keeps that across a reload too", async () => {
    const noEd25519 = { generateKey: async () => { throw new DOMException("Unrecognized name", "NotSupportedError"); } } as unknown as SubtleCrypto;
    const store = memorySeatKeyStore();
    const k = await new SeatKeyManager({ store, subtle: noEd25519 }).forMatch(matchKey, wallet);
    expect(k.kind).toBe("software");
    const msg = new Uint8Array([9, 9]);
    expect(verify(k.publicKey, msg, await k.signMessage(msg))).toBe(true);
    const reloaded = await new SeatKeyManager({ store, subtle: noEd25519 }).forMatch(matchKey, wallet);
    expect(reloaded.publicKey.equals(k.publicKey)).toBe(true);
    // no WebCrypto at all
    const none = await new SeatKeyManager({ store: memorySeatKeyStore(), subtle: undefined }).forMatch(matchKey, wallet);
    expect(none.kind).toBe("software");
  });

  it("without a store that survives (a private window) still plays the Match in this page", async () => {
    const m = new SeatKeyManager({ store: memorySeatKeyStore() });
    const k = await m.forMatch(matchKey, wallet);
    expect((await m.find(matchKey, wallet))!.publicKey.equals(k.publicKey)).toBe(true);
  });

  it("signs a v0 transaction in the slot the message requires and leaves the others alone", async () => {
    const m = new SeatKeyManager({ store: memorySeatKeyStore() });
    const k = await m.forMatch(matchKey, wallet);
    const payer = Keypair.generate();
    const msg = MessageV0.compile({
      payerKey: payer.publicKey,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: wallet, lamports: 1 }), { programId: SystemProgram.programId, keys: [{ pubkey: k.publicKey, isSigner: true, isWritable: false }], data: Buffer.alloc(0) }],
    });
    const tx = new VersionedTransaction(msg);
    tx.sign([payer]);
    const out = VersionedTransaction.deserialize(await k.signSerialized(tx.serialize()));
    const at = out.message.staticAccountKeys.findIndex((x) => x.equals(k.publicKey));
    expect(verify(k.publicKey, out.message.serialize(), out.signatures[at])).toBe(true);
    expect(verify(payer.publicKey, out.message.serialize(), out.signatures[0])).toBe(true);
    // a transaction that does not need the key comes back untouched
    const other = new VersionedTransaction(MessageV0.compile({ payerKey: payer.publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [] }));
    const raw = other.serialize();
    expect(await signInto(raw, k.publicKey, k.signMessage)).toEqual(raw);
  });

  it("signs a legacy transaction too", async () => {
    const m = new SeatKeyManager({ store: memorySeatKeyStore() });
    const k = await m.forMatch(matchKey, wallet);
    const tx = new Transaction({ feePayer: k.publicKey, recentBlockhash: PublicKey.default.toBase58() }).add(SystemProgram.transfer({ fromPubkey: k.publicKey, toPubkey: wallet, lamports: 1 }));
    await k.signTransaction(tx);
    expect(tx.verifySignatures()).toBe(true);
  });

  describe("prune", () => {
    it("deletes keys whose Match is gone or names another key, once past the grace, and keeps the named and the young ones", async () => {
      let now = 1_000_000;
      const m = new SeatKeyManager({ store: memorySeatKeyStore(), now: () => now });
      const live = await m.forMatch(`${opener}-1`, wallet);
      const closed = await m.forMatch(`${opener}-2`, wallet);
      const unknown = await m.forMatch(`${opener}-3`, wallet);
      now += 20 * 60_000;
      const young = await m.forMatch(`${opener}-4`, wallet);
      const status = async (key: string) => (key.endsWith("-1") ? "named" : key.endsWith("-3") ? "unknown" : "unnamed");
      expect((await m.prune(status as never)).sort()).toEqual([`${opener}-2`]);
      expect(await m.find(`${opener}-1`, wallet)).not.toBeNull();
      expect(await m.find(`${opener}-3`, wallet)).not.toBeNull();
      expect(await m.find(`${opener}-4`, wallet)).not.toBeNull();
      expect(await m.find(`${opener}-2`, wallet)).toBeNull();
      void live;
      void closed;
      void unknown;
      void young;
    });
  });
});
