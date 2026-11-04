import { Keypair, MessageV0, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it, vi } from "vitest";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { cosigned, ticketSteps } from "./cosigned";
import { SeatKeyManager, memorySeatKeyStore } from "./seat-key";

const walletKp = Keypair.generate();
const opener = Keypair.generate().publicKey.toBase58();

function walletSigner() {
  const signSerialized = vi.fn(async (raw: Uint8Array) => {
    const tx = VersionedTransaction.deserialize(raw);
    tx.sign([walletKp]);
    return tx.serialize();
  });
  const signMessage = vi.fn(async (m: Uint8Array) => nacl.sign.detached(m, walletKp.secretKey));
  const signer: ChainSigner = { publicKey: walletKp.publicKey, signTransaction: async (t) => t, signSerialized, signMessage };
  return { signer, signSerialized, signMessage };
}

describe("an entry's signers", () => {
  it("puts the wallet's signature and the seat key's on one transaction, asking the wallet once", async () => {
    const m = new SeatKeyManager({ store: memorySeatKeyStore() });
    const seat = await m.forMatch(`${opener}-1`, walletKp.publicKey);
    const { signer, signSerialized } = walletSigner();
    const relayer = Keypair.generate();
    const tx = new VersionedTransaction(
      MessageV0.compile({
        payerKey: relayer.publicKey,
        recentBlockhash: PublicKey.default.toBase58(),
        instructions: [
          { programId: SystemProgram.programId, keys: [{ pubkey: walletKp.publicKey, isSigner: true, isWritable: false }, { pubkey: seat.publicKey, isSigner: true, isWritable: false }], data: Buffer.alloc(0) },
        ],
      }),
    );
    const signed = VersionedTransaction.deserialize(await cosigned(signer, seat).signSerialized!(tx.serialize()));
    const msg = signed.message.serialize();
    for (const key of [walletKp.publicKey, seat.publicKey]) {
      const at = signed.message.staticAccountKeys.findIndex((k) => k.equals(key));
      expect(nacl.sign.detached.verify(msg, signed.signatures[at], key.toBytes())).toBe(true);
    }
    expect(signSerialized).toHaveBeenCalledTimes(1);
  });

  it("speaks as the wallet: its Account is the wallet's, and requests are wallet-signed", async () => {
    const m = new SeatKeyManager({ store: memorySeatKeyStore() });
    const seat = await m.forMatch(`${opener}-1`, walletKp.publicKey);
    const { signer, signMessage } = walletSigner();
    const both = cosigned(signer, seat);
    expect(both.publicKey.equals(walletKp.publicKey)).toBe(true);
    expect(both.seatMatch).toBeUndefined();
    await both.signMessage(new Uint8Array([1]));
    expect(signMessage).toHaveBeenCalledTimes(1);
  });

  it("stages a Ticket with the seat key alone, and still names the wallet", async () => {
    const m = new SeatKeyManager({ store: memorySeatKeyStore() });
    const seat = await m.forMatch(`${opener}-1`, walletKp.publicKey);
    const { signer, signSerialized } = walletSigner();
    const steps = ticketSteps(signer, seat);
    expect(steps.publicKey.equals(seat.publicKey)).toBe(true);
    expect(steps.wallet!.equals(walletKp.publicKey)).toBe(true);
    expect(steps.seatMatch).toBeUndefined();
    const tx = new VersionedTransaction(
      MessageV0.compile({ payerKey: Keypair.generate().publicKey, recentBlockhash: PublicKey.default.toBase58(), instructions: [{ programId: SystemProgram.programId, keys: [{ pubkey: seat.publicKey, isSigner: true, isWritable: false }], data: Buffer.alloc(0) }] }),
    );
    await steps.signSerialized!(tx.serialize());
    expect(signSerialized).not.toHaveBeenCalled();
  });
});
