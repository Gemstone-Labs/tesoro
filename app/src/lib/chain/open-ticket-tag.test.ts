import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { accountPda } from "./native";
import { openTicketIx } from "./ticket";

describe("open_ticket's target tag (seat-keys ticket 14)", () => {
  // The core that binds a Ticket to its Match reads a trailing u64; today's core ignores trailing argument bytes. Sending 0
  // (bound to nothing) keeps this page working across the core upgrade.
  it("ends with a zero target tag", () => {
    const player = Keypair.generate().publicKey;
    const ix = openTicketIx({ payer: player, authority: player, owner: accountPda(player), nonce: 3n, kind: "entry", game: "holdem", target: 500n, lines: 20, sponsored: false });
    // discriminator 8 + nonce 8 + kind 1 + game 32 + target 8 + lines 4 + target_tag 8
    expect(ix.data.length).toBe(69);
    expect(Buffer.from(ix.data.subarray(61))).toEqual(Buffer.alloc(8));
  });
});
