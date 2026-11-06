/**
 * Bob withdraws (or anyone releases) an Offer whose Backing Ticket Ben opened and never used: core refuses
 * `cancel_offer` / `expire_offer` while the Ticket is open (`OfferHasTicket`), so the Ticket is cancelled first, its
 * lines going home to Bob, and the Offer after.
 */
import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { ChainOffer } from "./backing";

const order: string[] = [];
const sendBase = vi.fn(async (_s: unknown, ixs: unknown[]) => {
  order.push(`sendBase:${ixs.length}`);
  return "sig";
});
const ticket = { address: Keypair.generate().publicKey };
const backingTicketOf = vi.fn(async () => ticket as unknown);
const cancelTicket = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {
  order.push("cancelTicket");
});
vi.mock("./client", () => ({ getChain: () => ({ base: {}, sendBase }) }));
vi.mock("./ticket", () => ({ backingTicketOf: (...a: unknown[]) => backingTicketOf(...(a as [])), cancelTicket: (...a: unknown[]) => cancelTicket(...a) }));

const bob = Keypair.generate();
const signer: ChainSigner = { publicKey: bob.publicKey, signTransaction: async (t) => t, signMessage: async (m) => m };
const getToken = async () => null;

function offer(ticketOpen: boolean): ChainOffer {
  return {
    address: Keypair.generate().publicKey,
    nonce: 1n,
    backer: Keypair.generate().publicKey.toBase58(),
    game: "holdem",
    entry: 500,
    shareBps: 4_000,
    status: "accepted",
    expiresAt: 0,
    useBy: 0,
    player: Keypair.generate().publicKey.toBase58(),
    request: Keypair.generate().publicKey.toBase58(),
    lines: [],
    matchId: null,
    refundableMatchId: null,
    ticketOpen,
  };
}

describe("withdrawing an Offer whose Backing Ticket is open", () => {
  beforeEach(() => {
    order.length = 0;
    vi.clearAllMocks();
  });

  it("Bob's Withdraw cancels Ben's unused Ticket with its own Offer, then the Offer", async () => {
    const { cancelOffer } = await import("./backing");
    const o = offer(true);
    await cancelOffer(signer, o, getToken);
    expect(backingTicketOf).toHaveBeenCalledWith({}, o.address, new PublicKey(o.backer));
    expect(cancelTicket.mock.calls[0][2]).toBe(ticket);
    expect(cancelTicket.mock.calls[0][3]).toEqual({ offer: o.address });
    expect(order).toEqual(["cancelTicket", "sendBase:1"]);
  });

  it("releasing an expired Offer cancels its Ticket first too", async () => {
    const { expireOffer } = await import("./backing");
    const o = offer(true);
    await expireOffer(signer, o, getToken);
    expect(order).toEqual(["cancelTicket", "sendBase:1"]);
  });

  it("an Offer with no open Ticket is withdrawn in one transaction", async () => {
    const { cancelOffer } = await import("./backing");
    await cancelOffer(signer, offer(false), getToken);
    expect(backingTicketOf).not.toHaveBeenCalled();
    expect(order).toEqual(["sendBase:1"]);
  });
});
