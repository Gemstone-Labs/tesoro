import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SponsorError } from "./sponsor-client";

const status = vi.fn();
const send = vi.fn();
vi.mock("./sponsor-client", async (orig) => ({ ...(await orig<typeof import("./sponsor-client")>()), sponsorStatus: () => status(), sponsoredSend: (...a: unknown[]) => send(...a) }));

import { finalizeFree } from "./game-finalize";

const relayer = Keypair.generate().publicKey;
const signer = { publicKey: Keypair.generate().publicKey, signSerialized: async (b: Uint8Array) => b } as never;
const ixFor = (caller: PublicKey) => new TransactionInstruction({ programId: caller, keys: [], data: Buffer.alloc(0) });
const game = () => ({ finalizeIx: vi.fn(async (c: PublicKey) => ixFor(c)), finalize: vi.fn(async () => "own-sig") });
const getToken = async () => null;

beforeEach(() => {
  status.mockReset().mockResolvedValue({ relayer: relayer.toBase58(), paused: false, low: false });
  send.mockReset().mockResolvedValue("free-sig");
});

describe("finalizeFree", () => {
  it("settles with the relayer as caller and never touches the Player's wallet funds", async () => {
    const g = game();
    expect(await finalizeFree(g, signer, getToken, {} as never)).toBe("free-sig");
    expect(g.finalizeIx).toHaveBeenCalledWith(relayer, {});
    expect(g.finalize).not.toHaveBeenCalled();
  });
  it("returns nothing to send when the Match is already settled", async () => {
    const g = { ...game(), finalizeIx: vi.fn(async () => null) };
    expect(await finalizeFree(g, signer, getToken, {} as never)).toBe("");
    expect(send).not.toHaveBeenCalled();
  });
  it("pays from the wallet only when free transactions are paused or empty", async () => {
    send.mockRejectedValue(new SponsorError("empty", "sponsor-empty", 503));
    const g = game();
    expect(await finalizeFree(g, signer, getToken, {} as never)).toBe("own-sig");
    status.mockResolvedValue({ relayer: relayer.toBase58(), paused: true, low: false });
    const h = game();
    expect(await finalizeFree(h, signer, getToken, {} as never)).toBe("own-sig");
  });
  it("does not fall back to the wallet for a refusal or a chain failure (the Match moved on)", async () => {
    send.mockRejectedValue(new SponsorError("Transaction failed", "chain", 502));
    const g = game();
    await expect(finalizeFree(g, signer, getToken, {} as never)).rejects.toThrow("Transaction failed");
    expect(g.finalize).not.toHaveBeenCalled();
  });
});
