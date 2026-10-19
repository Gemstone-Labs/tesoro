import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { newNonce, signedMessage, type SignedFields } from "../../lib/chain/signed-request";
import { MemoryNotifyStore } from "../notify/store";
import { DemoHttpError, type AuthEnv } from "../request-auth";
import { inviteKeypair } from "./key";
import { handleRedeem, type RedeemDeps } from "./redeem";
import { hashCode, MemoryInviteStore, newInviteCode, normalizeCode } from "./store";

const NOW = 1_800_000_000_000;
const env: AuthEnv = { production: false, devWallet: true, verifyToken: async () => null };

function signed(kp: Keypair, fields: SignedFields) {
  const address = kp.publicKey.toBase58();
  const nonce = newNonce();
  const sig = nacl.sign.detached(new TextEncoder().encode(signedMessage("tesoro-invite", "redeem", address, NOW, nonce, fields)), kp.secretKey);
  return { step: "redeem", address, ts: NOW, nonce, signature: Buffer.from(sig).toString("base64"), ...fields };
}

function setup(existing: string[] = []) {
  const invites = new MemoryInviteStore();
  const notify = new MemoryNotifyStore();
  const events: string[] = [];
  const deps: RedeemDeps = {
    invites,
    notify,
    accountExists: async (a) => existing.includes(a),
    buildCoSigned: async (a) => {
      events.push(`sign:${a}`);
      return `tx-for-${a}`;
    },
    token: () => "t".repeat(32),
  };
  return { deps, invites, notify, events };
}

const run = (deps: RedeemDeps, kp: Keypair, code: string) => handleRedeem(deps, signed(kp, { code }), null, env, NOW);
const errCode = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DemoHttpError ? e.code : String(e);
  }
};

describe("Invite redeem", () => {
  it("co-signs an unused code, marks it used and makes its email the verified notification email", async () => {
    const { deps, invites, notify, events } = setup();
    const code = newInviteCode();
    await invites.create(hashCode(code), "ana@example.com");
    const kp = Keypair.generate();
    const out = await run(deps, kp, code);
    expect(out.tx).toBe(`tx-for-${kp.publicKey.toBase58()}`);
    expect(invites.rows.get(hashCode(code))?.usedBy).toBe(kp.publicKey.toBase58());
    expect(await notify.get(kp.publicKey.toBase58())).toMatchObject({ email: "ana@example.com", verified: true, enabled: true });
    expect(events).toHaveLength(1);
  });

  it("gives the same wallet a fresh co-signed transaction again, without touching its email", async () => {
    const { deps, invites, notify, events } = setup();
    const code = newInviteCode();
    await invites.create(hashCode(code), "ana@example.com");
    const kp = Keypair.generate();
    await run(deps, kp, code);
    await notify.saveEmail(kp.publicKey.toBase58(), "new@example.com", "z".repeat(32));
    await run(deps, kp, code);
    expect(events).toHaveLength(2);
    expect((await notify.get(kp.publicKey.toBase58()))?.email).toBe("new@example.com");
  });

  it("refuses a used code from another wallet, and never co-signs for it", async () => {
    const { deps, invites, events } = setup();
    const code = newInviteCode();
    await invites.create(hashCode(code), "ana@example.com");
    await run(deps, Keypair.generate(), code);
    expect(await errCode(run(deps, Keypair.generate(), code))).toBe("code-used");
    expect(events).toHaveLength(1);
  });

  it("refuses a wrong code and a malformed one, without co-signing", async () => {
    const { deps, events } = setup();
    expect(await errCode(run(deps, Keypair.generate(), newInviteCode()))).toBe("unknown-code");
    expect(await errCode(run(deps, Keypair.generate(), "short"))).toBe("bad-code");
    expect(events).toHaveLength(0);
  });

  it("does not spend a code on a wallet that already has an Account", async () => {
    const kp = Keypair.generate();
    const { deps, invites, events } = setup([kp.publicKey.toBase58()]);
    const code = newInviteCode();
    await invites.create(hashCode(code), "ana@example.com");
    expect(await errCode(run(deps, kp, code))).toBe("has-account");
    expect(invites.rows.get(hashCode(code))?.usedBy).toBeNull();
    expect(events).toHaveLength(0);
  });

  it("accepts a code typed in lowercase with spaces", async () => {
    const { deps, invites } = setup();
    const code = newInviteCode();
    await invites.create(hashCode(code), "ana@example.com");
    expect((await run(deps, Keypair.generate(), code.toLowerCase().replace(/-/g, " "))).tx).toMatch(/^tx-for-/);
  });
});

describe("Invite codes", () => {
  it("are 80-bit, normalised and stored hashed", () => {
    const a = newInviteCode();
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(newInviteCode()).not.toBe(a);
    expect(normalizeCode(" ab-cd o1il ")).toBe("ABCD0111");
    expect(hashCode(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashCode(a)).toBe(hashCode(a.toLowerCase()));
  });
});

describe("Invite key", () => {
  const kp = Keypair.generate();
  it("reads base58 and a JSON array", async () => {
    const bs58 = (await import("bs58")).default;
    expect(inviteKeypair(bs58.encode(kp.secretKey)).publicKey.equals(kp.publicKey)).toBe(true);
    expect(inviteKeypair(JSON.stringify(Array.from(kp.secretKey))).publicKey.equals(kp.publicKey)).toBe(true);
  });
  it("rejects a missing or malformed key without quoting it", () => {
    expect(() => inviteKeypair(undefined)).toThrow("not set");
    expect(() => inviteKeypair("secret-value-123")).toThrow(/neither base58/);
    try {
      inviteKeypair("secret-value-123");
    } catch (e) {
      expect(String(e)).not.toContain("secret-value-123");
    }
  });
});
