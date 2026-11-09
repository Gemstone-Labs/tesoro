import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { keypairSigner, type ChainSigner } from "@/games/block-puzzle/chain";
import { SponsorError } from "@/lib/chain/sponsor-client";
import { sendStepOff } from "./step-off-send";

const wallet = keypairSigner(Keypair.generate());
const seatKey = keypairSigner(Keypair.generate());

/** A page's step-off: who each send was signed by and which caller its instruction names. */
function page(o: { sponsorSays?: (signer: ChainSigner) => Error | null } = {}) {
  const sent: { via: "sponsor" | "self"; signer: string; caller: string }[] = [];
  const ixFor = async (caller: PublicKey) => new TransactionInstruction({ programId: PublicKey.default, keys: [{ pubkey: caller, isSigner: true, isWritable: false }], data: Buffer.alloc(0) });
  const record = (via: "sponsor" | "self") => async (signer: ChainSigner, ixs: TransactionInstruction[]) => {
    const e = via === "sponsor" ? (o.sponsorSays?.(signer) ?? null) : null;
    if (e) throw e;
    sent.push({ via, signer: signer.publicKey.toBase58(), caller: ixs.at(-1)!.keys[0].pubkey.toBase58() });
    return "sig";
  };
  return { sent, deps: { build: ixFor, sponsored: record("sponsor"), selfPaid: record("self") } };
}
const name = (s: ChainSigner) => s.publicKey.toBase58();

describe("stepping off", () => {
  it("the seat key the seat names steps off through the sponsor: the wallet signs nothing", async () => {
    const p = page();
    await sendStepOff({ wallet, seat: seatKey, seatSigner: seatKey.publicKey, ...p.deps });
    expect(p.sent).toEqual([{ via: "sponsor", signer: name(seatKey), caller: name(seatKey) }]);
  });

  it("no seat key on this device, or a seat that names another key: the wallet steps off, as before", async () => {
    for (const [seat, seatSigner] of [
      [null, wallet.publicKey],
      [seatKey, Keypair.generate().publicKey],
    ] as const) {
      const p = page();
      await sendStepOff({ wallet, seat, seatSigner, ...p.deps });
      expect(p.sent).toEqual([{ via: "sponsor", signer: name(wallet), caller: name(wallet) }]);
    }
  });

  it("a sponsor refusal of the seat key falls back to the wallet; a refusal of the wallet's too ends with the wallet paying", async () => {
    const seatRefused = page({ sponsorSays: (s) => (s === seatKey ? new SponsorError("Free transactions are paused.", "sponsor-paused", 503) : null) });
    await sendStepOff({ wallet, seat: seatKey, seatSigner: seatKey.publicKey, ...seatRefused.deps });
    expect(seatRefused.sent).toEqual([{ via: "sponsor", signer: name(wallet), caller: name(wallet) }]);
    const allRefused = page({ sponsorSays: () => new SponsorError("Free transactions are paused.", "sponsor-paused", 503) });
    await sendStepOff({ wallet, seat: seatKey, seatSigner: seatKey.publicKey, ...allRefused.deps });
    expect(allRefused.sent).toEqual([{ via: "self", signer: name(wallet), caller: name(wallet) }]);
  });

  it("a seat-key step-off that failed on chain is not sent again by the wallet", async () => {
    const p = page({ sponsorSays: (s) => (s === seatKey ? new Error("step off failed: Custom 6400") : null) });
    await expect(sendStepOff({ wallet, seat: seatKey, seatSigner: seatKey.publicKey, ...p.deps })).rejects.toThrow("6400");
    expect(p.sent).toEqual([]);
  });
});
