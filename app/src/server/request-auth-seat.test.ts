import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { newNonce, signedMessage, type SignedFields } from "../lib/chain/signed-request";
import { accountPda } from "../lib/chain/native";
import { DemoHttpError, NonceStore, verifySignedRequest, type AuthEnv } from "./request-auth";

const STEPS = ["touch", "entry"] as const;
const NOW = 1_800_000_000_000;
const dev: AuthEnv = { production: false, devWallet: true, verifyToken: async () => null };
const ANA = Keypair.generate();
/** Ana's login; the identity token "id-ana" lists her wallet, "id-bob" is Bob's login with his own wallet. */
const privy: AuthEnv = {
  privyAppId: "app",
  production: true,
  devWallet: false,
  verifyToken: async (t) => (t === "good" ? "did:privy:ana" : null),
  verifyIdentity: async (t) => (t === "id-ana" ? { sub: "did:privy:ana", wallets: [ANA.publicKey.toBase58()] } : t === "id-bob" ? { sub: "did:privy:bob", wallets: [Keypair.generate().publicKey.toBase58()] } : null),
};

/** `by` signs for the wallet `wallet`; when they differ it is a seat key's request and the body names it. */
function request(wallet: Keypair, by: Keypair, step: string, fields: SignedFields = {}, nonce = newNonce()) {
  const address = wallet.publicKey.toBase58();
  const seat = !by.publicKey.equals(wallet.publicKey);
  const message = signedMessage("tesoro-presence", step, address, NOW, nonce, fields, seat ? by.publicKey.toBase58() : undefined);
  const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(message), by.secretKey)).toString("base64");
  return { step, address, ts: NOW, nonce, signature, ...(seat ? { signer: by.publicKey.toBase58() } : {}), ...fields };
}
const verify = (body: unknown, opts: { seatKey?: boolean; nonces?: NonceStore; env?: AuthEnv; auth?: string | null; id?: string | null } = {}) =>
  verifySignedRequest("tesoro-presence", STEPS, body, opts.auth ?? null, { nonces: opts.nonces ?? new NonceStore(), env: opts.env ?? dev, now: NOW, seatKey: opts.seatKey, tokenOnly: ["entry"], identityToken: opts.id });
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DemoHttpError ? e.code : String(e);
  }
};

describe("seat keys in the signed request verifier (ticket 10)", () => {
  const wallet = Keypair.generate();
  const seat = Keypair.generate();
  const match = { match: "M-1" };

  it("returns the wallet, its Account and the signer separately", async () => {
    const r = await verify(request(wallet, seat, "touch", match), { seatKey: true });
    expect(r.seat).toBe(true);
    expect(r.address.equals(wallet.publicKey)).toBe(true);
    expect(r.signer.equals(seat.publicKey)).toBe(true);
    expect(r.account.equals(accountPda(wallet.publicKey))).toBe(true);
    const w = await verify(request(wallet, wallet, "touch", match), { seatKey: true });
    expect(w).toMatchObject({ seat: false });
    expect(w.signer.equals(wallet.publicKey)).toBe(true);
  });

  it("refuses a seat key on a route that did not opt in, before looking at anything else", async () => {
    expect(await code(verify(request(wallet, seat, "touch", match)))).toBe("wallet-only");
    expect(await code(verify({ ...request(wallet, seat, "touch", match), ts: 1 }))).toBe("wallet-only");
  });

  it("derives nothing from the signer: a seat key cannot speak for another wallet, and a stranger's key signs nothing", async () => {
    const stranger = Keypair.generate();
    // signed by the stranger but naming the seat key
    const forged = { ...request(wallet, stranger, "touch", match), signer: seat.publicKey.toBase58() };
    expect(await code(verify(forged, { seatKey: true }))).toBe("bad-signature");
    // the seat key's signature moved to another wallet's address
    const moved = { ...request(wallet, seat, "touch", match), address: stranger.publicKey.toBase58() };
    expect(await code(verify(moved, { seatKey: true }))).toBe("bad-signature");
    // a wallet signature (no seat suffix) cannot pass as a seat key's, nor the other way round
    const asWallet = { ...request(wallet, wallet, "touch", match), signer: seat.publicKey.toBase58() };
    expect(await code(verify(asWallet, { seatKey: true }))).toBe("bad-signature");
    const asSeat = request(wallet, seat, "touch", match);
    const { signer: _drop, ...noSigner } = asSeat;
    void _drop;
    expect(await code(verify(noSigner, { seatKey: true }))).toBe("bad-signature");
    // changing the Match after signing
    expect(await code(verify({ ...request(wallet, seat, "touch", match), match: "M-2" }, { seatKey: true }))).toBe("bad-signature");
  });

  it("scopes a nonce to the key, the wallet and the Match", async () => {
    const nonces = new NonceStore();
    const nonce = newNonce();
    expect(await code(verify(request(wallet, seat, "touch", match, nonce), { seatKey: true, nonces }))).toBe("ok");
    expect(await code(verify(request(wallet, seat, "touch", match, nonce), { seatKey: true, nonces }))).toBe("replayed");
    // the same nonce for another Match, or by another key for the same wallet, is a different request, not a replay
    expect(await code(verify(request(wallet, seat, "touch", { match: "M-2" }, nonce), { seatKey: true, nonces }))).toBe("ok");
    expect(await code(verify(request(wallet, wallet, "touch", match, nonce), { seatKey: true, nonces }))).toBe("ok");
  });

  describe("token-only steps", () => {
    const ana = ANA;
    const body = (extra: object = {}) => ({ step: "entry", address: ana.publicKey.toBase58(), ts: NOW, nonce: newNonce(), ...extra });

    it("need a valid Privy token and no wallet signature", async () => {
      expect(await code(verify(body(), { env: privy }))).toBe("signed-out");
      expect(await code(verify(body(), { env: privy, auth: "Bearer bad" }))).toBe("signed-out");
      const r = await verify(body(), { env: privy, auth: "Bearer good", id: "id-ana" });
      expect(r).toMatchObject({ step: "entry", seat: false, sub: "did:privy:ana" });
      expect(r.address.equals(ana.publicKey)).toBe(true);
    });
    it("need the identity token to show the signed-in user owns the wallet", async () => {
      const other = Keypair.generate();
      const forOther = { step: "entry", address: other.publicKey.toBase58(), ts: NOW, nonce: newNonce() };
      // Ana's valid login and identity token, asking to build for someone else's wallet
      expect(await code(verify(forOther, { env: privy, auth: "Bearer good", id: "id-ana" }))).toBe("wallet-not-yours");
      // her own wallet but no identity token, a token that is not hers, or one that does not verify
      expect(await code(verify(body(), { env: privy, auth: "Bearer good" }))).toBe("wallet-not-yours");
      expect(await code(verify(body(), { env: privy, auth: "Bearer good", id: "id-bob" }))).toBe("wallet-not-yours");
      expect(await code(verify(body(), { env: privy, auth: "Bearer good", id: "junk" }))).toBe("wallet-not-yours");
      expect(await code(verify(body(), { env: { ...privy, verifyIdentity: undefined }, auth: "Bearer good", id: "id-ana" }))).toBe("wallet-not-yours");
    });
    it("replay and stale checks still apply, and a seat key is refused", async () => {
      const nonces = new NonceStore();
      const b = body();
      expect(await code(verify(b, { env: privy, auth: "Bearer good", nonces, id: "id-ana" }))).toBe("ok");
      expect(await code(verify(b, { env: privy, auth: "Bearer good", nonces, id: "id-ana" }))).toBe("replayed");
      expect(await code(verify(body({ ts: NOW - 10 * 60_000 }), { env: privy, auth: "Bearer good", id: "id-ana" }))).toBe("stale");
      expect(await code(verify(body({ signer: seat.publicKey.toBase58() }), { env: privy, auth: "Bearer good", seatKey: true }))).toBe("wallet-only");
    });
    it("do not relax the steps that need a signature", async () => {
      const { signature: _s, ...unsigned } = request(wallet, wallet, "touch", match);
      void _s;
      expect(await code(verify(unsigned))).toBe("bad-request");
    });
    it("fail closed in production without Privy", async () => {
      expect(await code(verify(body(), { env: { ...privy, privyAppId: undefined } }))).toBe("not-configured");
    });
  });
});
