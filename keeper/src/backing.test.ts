import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { lapsedOffers } from "./backing.ts";

const NOW = 1_800_000_000;
const n = (v: number) => ({ toString: () => String(v) });
const offer = (status: string, expiresAt: number, useBy: number, ticketOpen = false) => ({ publicKey: Keypair.generate().publicKey, account: { inner: { status: { [status]: {} }, expiresAt: n(expiresAt), useBy: n(useBy), ticketOpen } } });

describe("lapsed offers", () => {
  it("an Open Offer lapses at expires_at, an Accepted one at use_by, and finished ones never", () => {
    const rows = lapsedOffers([offer("open", NOW - 1, NOW + 9), offer("open", NOW + 5, 0), offer("accepted", NOW + 99, NOW - 1), offer("consumed", 0, 0), offer("cancelled", 0, 0)], NOW);
    assert.deepEqual(rows.map((r) => [r.st, r.late]), [["open", true], ["open", false], ["accepted", true]]);
  });
  it("knows when a Backing Ticket is open on the Offer", () => {
    assert.equal(lapsedOffers([offer("accepted", 0, NOW - 1, true)], NOW)[0].ticketOpen, true);
  });
});
