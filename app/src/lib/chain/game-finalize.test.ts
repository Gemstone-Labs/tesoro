import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SponsorError } from "./sponsor-client";

const status = vi.fn();
const send = vi.fn();
vi.mock("./sponsor-client", async (orig) => ({ ...(await orig<typeof import("./sponsor-client")>()), sponsorStatus: () => status(), sponsoredSend: (...a: unknown[]) => send(...a) }));

import { UNTABLED_GAP_MS, closeAssignmentFree, finalizeFree, refundUntabledFree, refundWhenUntabled } from "./game-finalize";

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

describe("refundUntabledFree and closeAssignmentFree", () => {
  it("send the Game's own instruction with the relayer as caller, and pay from the wallet when paused", async () => {
    const g = { refundUntabledIx: vi.fn(async (c: PublicKey) => ixFor(c)), refundUntabled: vi.fn(async () => "own"), closeAssignmentIx: vi.fn(async (c: PublicKey) => ixFor(c)), closeAssignment: vi.fn(async () => "own") };
    const match = Keypair.generate().publicKey;
    expect(await refundUntabledFree(g, signer, getToken, match)).toBe("free-sig");
    expect(g.refundUntabledIx).toHaveBeenCalledWith(relayer, match);
    expect(await closeAssignmentFree(g, signer, getToken, {} as never)).toBe("free-sig");
    expect(g.closeAssignmentIx).toHaveBeenCalledWith(relayer, {});
    status.mockResolvedValue({ relayer: relayer.toBase58(), paused: true, low: false });
    expect(await closeAssignmentFree(g, signer, getToken, {} as never)).toBe("own");
  });
});

describe("when the sponsor refuses", () => {
  it("a delisted Game or a Player it will not pay for falls back to the wallet; a step that would fail does not", async () => {
    for (const code of ["unknown-program", "not-your-match", "match-limit"]) {
      send.mockRejectedValue(new SponsorError("no", code, 400));
      const g = game();
      expect(await finalizeFree(g, signer, getToken, {} as never)).toBe("own-sig");
    }
    for (const code of ["would-fail", "costs-too-much", "chain"]) {
      send.mockRejectedValue(new SponsorError("no", code, 409));
      const g = game();
      await expect(finalizeFree(g, signer, getToken, {} as never)).rejects.toThrow();
      expect(g.finalize).not.toHaveBeenCalled();
    }
  });
});

describe("refundWhenUntabled (ticket 58)", () => {
  const T = 1_800_000_000;
  // Joined at T: tesoro_core's deadline is the join plus an hour, the Game refunds after five minutes.
  const joined = { status: "active" as const, sides: [{}, {}], deadline: T + 3_600 };

  it("sends the refund once the table wait is over, not before", async () => {
    const sendIt = vi.fn(async () => "sig");
    const last = { current: 0 };
    expect(await refundWhenUntabled(joined, (T + 299) * 1000, last, sendIt)).toBe(false);
    expect(await refundWhenUntabled(joined, (T + 300) * 1000, last, sendIt)).toBe(true);
    expect(sendIt).toHaveBeenCalledTimes(1);
  });

  it("waits between tries", async () => {
    const sendIt = vi.fn(async () => "sig");
    const last = { current: 0 };
    await refundWhenUntabled(joined, (T + 300) * 1000, last, sendIt);
    await refundWhenUntabled(joined, (T + 300) * 1000 + UNTABLED_GAP_MS - 1, last, sendIt);
    await refundWhenUntabled(joined, (T + 300) * 1000 + UNTABLED_GAP_MS, last, sendIt);
    expect(sendIt).toHaveBeenCalledTimes(2);
  });

  it("leaves a Match nobody joined alone (the opener cancelled it)", async () => {
    const sendIt = vi.fn(async () => "sig");
    expect(await refundWhenUntabled({ ...joined, sides: [{}] }, (T + 900) * 1000, { current: 0 }, sendIt)).toBe(false);
    expect(sendIt).not.toHaveBeenCalled();
  });

  it("takes a refusal because the other page refunded first, or a table came, as done; anything else is thrown", async () => {
    await expect(refundWhenUntabled(joined, (T + 300) * 1000, { current: 0 }, async () => Promise.reject(new Error("custom program error: NotUntabled")))).resolves.toBe(true);
    await expect(refundWhenUntabled(joined, (T + 300) * 1000, { current: 0 }, async () => Promise.reject(new Error("network down")))).rejects.toThrow("network down");
  });
});
