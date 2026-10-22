import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const relayer = Keypair.generate().publicKey;
const m = vi.hoisted(() => ({ paused: false, sponsoredSend: vi.fn(async () => "sponsored"), sendBase: vi.fn(async () => "own"), ensureSol: vi.fn(async () => undefined) }));

vi.mock("./client", () => ({ getChain: () => ({ sendBase: m.sendBase }) }));
vi.mock("./demo-client", () => ({ ensureSol: m.ensureSol }));
vi.mock("./sponsor-client", async (orig) => ({
  ...(await orig<typeof import("./sponsor-client")>()),
  sponsorStatus: async () => ({ relayer: relayer.toBase58(), paused: m.paused, low: false }),
  sponsoredSend: m.sponsoredSend,
}));

import { sendSponsoredOrOwn } from "./sponsored-or-own";
import { SponsorError } from "./sponsor-client";

const signer = { publicKey: Keypair.generate().publicKey, signSerialized: async (b: Uint8Array) => b } as never;
const seen: { payer: PublicKey; sponsored: boolean }[] = [];
const build = async (payer: PublicKey, sponsored: boolean) => {
  seen.push({ payer, sponsored });
  return [];
};

describe("sendSponsoredOrOwn", () => {
  beforeEach(() => {
    m.paused = false;
    seen.length = 0;
    vi.clearAllMocks();
    m.sponsoredSend.mockImplementation(async () => "sponsored");
  });

  it("builds the step for the relayer and lets it pay", async () => {
    expect(await sendSponsoredOrOwn(signer, async () => null, build)).toBe("sponsored");
    expect(seen).toEqual([{ payer: relayer, sponsored: true }]);
    expect(m.ensureSol).not.toHaveBeenCalled();
  });

  it("pays its own rent when the relayer is paused, refuses, or the wallet cannot take part", async () => {
    m.paused = true;
    expect(await sendSponsoredOrOwn(signer, async () => null, build)).toBe("own");
    expect(seen.at(-1)).toEqual({ payer: (signer as { publicKey: PublicKey }).publicKey, sponsored: false });
    expect(m.ensureSol).toHaveBeenCalledTimes(1);
    m.paused = false;
    m.sponsoredSend.mockRejectedValueOnce(new SponsorError("limit", "account-limit", 429));
    expect(await sendSponsoredOrOwn(signer, async () => null, build)).toBe("own");
    expect(await sendSponsoredOrOwn({ publicKey: Keypair.generate().publicKey } as never, async () => null, build)).toBe("own");
  });
});
