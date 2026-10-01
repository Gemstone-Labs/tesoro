import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { newNonce, signedMessage, type SignedFields } from "../lib/chain/signed-request";
import { DemoHttpError, NonceStore, verifySignedRequest, type AuthEnv } from "./request-auth";

const STEPS = ["fund-evm", "init-position"] as const;
const NOW = 1_800_000_000_000;
const dev: AuthEnv = { production: false, devWallet: true, verifyToken: async () => null };
const privy: AuthEnv = { privyAppId: "app", production: true, devWallet: false, verifyToken: async (t) => (t === "good" ? "did:privy:alice" : null) };

function signed(kp: Keypair, step: string, fields: SignedFields, nonce = newNonce(), ts = NOW) {
  const address = kp.publicKey.toBase58();
  const sig = nacl.sign.detached(new TextEncoder().encode(signedMessage("tesoro-eth", step, address, ts, nonce, fields)), kp.secretKey);
  return { step, address, ts, nonce, signature: Buffer.from(sig).toString("base64"), ...fields };
}

const verify = (body: unknown, opts: { nonces?: NonceStore; env?: AuthEnv; auth?: string | null; now?: number } = {}) =>
  verifySignedRequest("tesoro-eth", STEPS, body, opts.auth ?? null, { nonces: opts.nonces ?? new NonceStore(), env: opts.env ?? dev, now: opts.now ?? NOW });

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DemoHttpError ? e.code : String(e);
  }
};

describe("signed route requests (OC-09)", () => {
  const kp = Keypair.generate();

  it("accepts a request signed over all its fields", async () => {
    const r = await verify(signed(kp, "fund-evm", { evm: "0x" + "11".repeat(20) }));
    expect(r.fields.evm).toBe("0x" + "11".repeat(20));
    expect(r.sub).toBeNull();
  });

  // The old message was `tesoro-eth|step|address|ts`: a captured request could be resent with another `evm`.
  it("rejects a captured request with a changed or added field", async () => {
    const body = signed(kp, "fund-evm", { evm: "0x" + "11".repeat(20) });
    expect(await code(verify({ ...body, evm: "0x" + "22".repeat(20) }))).toBe("bad-signature");
    const init = signed(kp, "init-position", { vault: "0xabc", id: "7" });
    for (const tampered of [{ id: "8" }, { vault: "0xdef" }, { months: 12 }, { position: "x" }, { sourceIndex: 0 }]) {
      expect(await code(verify({ ...init, ...tampered }))).toBe("bad-signature");
    }
    expect(await code(verify({ ...init, extra: "1" }))).toBe("bad-request");
    expect(await code(verify({ ...init, id: { toString: () => "7" } }))).toBe("bad-request");
  });

  it("rejects a replayed nonce within the window and a stale timestamp", async () => {
    const nonces = new NonceStore();
    const body = signed(kp, "fund-evm", { evm: "0x" + "11".repeat(20) });
    expect(await code(verify(body, { nonces }))).toBe("ok");
    expect(await code(verify(body, { nonces, now: NOW + 60_000 }))).toBe("replayed");
    expect(await code(verify(signed(kp, "fund-evm", {}, newNonce(), NOW - 6 * 60_000), { nonces }))).toBe("stale");
    expect(await code(verify({ ...signed(kp, "fund-evm", {}), nonce: "short" }))).toBe("bad-request");
  });
});

describe("Privy binding (OC-08)", () => {
  const kp = Keypair.generate();

  it("fails closed in production without a Privy app id", async () => {
    expect(await code(verify(signed(kp, "fund-evm", {}), { env: { ...privy, privyAppId: undefined } }))).toBe("not-configured");
  });

  it("requires a valid token and returns its sub for quotas", async () => {
    expect(await code(verify(signed(kp, "fund-evm", {}), { env: privy }))).toBe("signed-out");
    expect(await code(verify(signed(kp, "fund-evm", {}), { env: privy, auth: "Bearer bad" }))).toBe("signed-out");
    const r = await verify(signed(kp, "fund-evm", {}), { env: privy, auth: "Bearer good" });
    expect(r.sub).toBe("did:privy:alice");
  });

  it("a rejected token does not burn the nonce", async () => {
    const nonces = new NonceStore();
    const body = signed(kp, "fund-evm", {});
    expect(await code(verify(body, { nonces, env: privy, auth: "Bearer bad" }))).toBe("signed-out");
    expect(await code(verify(body, { nonces, env: privy, auth: "Bearer good" }))).toBe("ok");
  });
});
