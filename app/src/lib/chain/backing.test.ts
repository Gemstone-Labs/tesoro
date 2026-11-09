import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { expireOfferIx, type ChainOffer } from "./backing";
import { protectionsPda } from "./native";

const k = () => Keypair.generate().publicKey;

describe("expire_offer as the app sends it", () => {
  // The W3 core gives an Offer's Entry Limit count back to the Backer's Protections, so it needs them writable; the
  // current core only reads them (to see whether the Backer is away).
  it("names the Backer's Protections, writable", () => {
    const backer = k();
    const offer = { address: k(), backer: backer.toBase58(), status: "open", request: k().toBase58() } as ChainOffer;
    const ix = expireOfferIx(k(), offer);
    expect(ix.keys.find((m) => m.pubkey.equals(protectionsPda(backer)))).toMatchObject({ isSigner: false, isWritable: true });
  });
});
