import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { newNonce, signedMessage } from "../../lib/chain/signed-request";
import { DemoHttpError, type AuthEnv } from "../request-auth";
import { handleAge } from "./routes";
import { MemoryAgeStore } from "./store";

const NOW = 1_800_000_000_000;
const dev: AuthEnv = { production: false, devWallet: true, verifyToken: async () => null };

function signed(kp: Keypair, step: string) {
  const address = kp.publicKey.toBase58();
  const nonce = newNonce();
  const sig = nacl.sign.detached(new TextEncoder().encode(signedMessage("tesoro-age", step, address, NOW, nonce, {})), kp.secretKey);
  return { step, address, ts: NOW, nonce, signature: Buffer.from(sig).toString("base64") };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DemoHttpError ? e.code : String(e);
  }
};

describe("18+ confirmation", () => {
  const setup = () => {
    const store = new MemoryAgeStore();
    return { store, call: (body: unknown) => handleAge({ store, now: () => NOW }, body, null, dev, NOW) };
  };

  it("is required the first time, then not after the Account confirms", async () => {
    const { call, store } = setup();
    const kp = Keypair.generate();
    expect(await call(signed(kp, "status"))).toEqual({ confirmed: false });
    expect(await call(signed(kp, "confirm"))).toEqual({ confirmed: true });
    expect(await call(signed(kp, "status"))).toEqual({ confirmed: true });
    expect(store.rows.get(kp.publicKey.toBase58())).toBe(new Date(NOW).toISOString());
  });

  it("keeps Accounts apart and keeps the first confirmation time", async () => {
    const { call, store } = setup();
    const a = Keypair.generate();
    const b = Keypair.generate();
    await call(signed(a, "confirm"));
    expect(await call(signed(b, "status"))).toEqual({ confirmed: false });
    await handleAge({ store, now: () => NOW + 5000 }, signed(a, "confirm"), null, dev, NOW);
    expect(store.rows.get(a.publicKey.toBase58())).toBe(new Date(NOW).toISOString());
  });

  it("refuses unsigned, wrong-signer, tampered, replayed and unknown-step requests", async () => {
    const { call, store } = setup();
    const kp = Keypair.generate();
    const other = Keypair.generate();
    const ok = signed(kp, "confirm");
    expect(await code(call({ ...ok, signature: undefined }))).toBe("bad-request");
    expect(await code(call({ ...signed(kp, "confirm"), address: other.publicKey.toBase58() }))).not.toBe("ok");
    expect(await code(call({ ...signed(kp, "status"), step: "confirm" }))).not.toBe("ok");
    expect(await code(call({ ...signed(kp, "confirm"), code: "x" }))).toBe("bad-signature");
    expect(await code(call(signed(kp, "delete")))).toBe("bad-request");
    expect(store.rows.size).toBe(0);
    expect(await code(call(ok))).toBe("ok");
    expect(await code(call(ok))).not.toBe("ok");
  });
});
