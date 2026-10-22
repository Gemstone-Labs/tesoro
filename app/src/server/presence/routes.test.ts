import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { accountKeyOf } from "../../lib/chain/account-key";
import { newNonce, signedMessage } from "../../lib/chain/signed-request";
import { DemoHttpError, type AuthEnv } from "../request-auth";
import { MemoryPresenceStore } from "./lease";
import { handleFresh, handleTouch } from "./routes";

const NOW = 1_800_000_000_000;
const dev: AuthEnv = { production: false, devWallet: true, verifyToken: async () => null };

function signed(kp: Keypair, match: string) {
  const address = kp.publicKey.toBase58();
  const nonce = newNonce();
  const sig = nacl.sign.detached(new TextEncoder().encode(signedMessage("tesoro-presence", "touch", address, NOW, nonce, { match })), kp.secretKey);
  return { step: "touch", address, ts: NOW, nonce, match, signature: Buffer.from(sig).toString("base64") };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DemoHttpError ? e.code : String(e);
  }
};

describe("queue presence routes", () => {
  it("the opener touches, then the Match is fresh; 20 s later still, 40 s later not", async () => {
    const store = new MemoryPresenceStore();
    let now = NOW;
    const deps = { store, now: () => now };
    const kp = Keypair.generate();
    const match = `${accountKeyOf(kp.publicKey.toBase58())}-3`;
    expect(await handleTouch(deps, signed(kp, match), null, dev, NOW)).toEqual({ ok: true });
    expect(await handleFresh(deps, `${match},x-1`)).toEqual({ fresh: [match] });
    now = NOW + 20_000;
    expect((await handleFresh(deps, match)).fresh).toEqual([match]);
    now = NOW + 40_000;
    expect((await handleFresh(deps, match)).fresh).toEqual([]);
  });
  it("refuses a Player who is not the opener, and a malformed key", async () => {
    const store = new MemoryPresenceStore();
    const deps = { store, now: () => NOW };
    const kp = Keypair.generate();
    const other = `${accountKeyOf(Keypair.generate().publicKey.toBase58())}-3`;
    expect(await code(handleTouch(deps, signed(kp, other), null, dev, NOW))).toBe("not-opener");
    expect(await code(handleTouch(deps, signed(kp, "nonsense"), null, dev, NOW))).toBe("bad-request");
    expect(store.map.size).toBe(0);
  });
  it("refuses a missing or oversized id list", async () => {
    const deps = { store: new MemoryPresenceStore() };
    expect(await code(handleFresh(deps, null))).toBe("bad-request");
    expect(await code(handleFresh(deps, Array.from({ length: 101 }, (_, i) => `k-${i}`).join(",")))).toBe("bad-request");
  });
});
