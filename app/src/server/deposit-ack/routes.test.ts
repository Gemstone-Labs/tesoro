import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { DEPOSIT_ACK_VERSION } from "../../lib/deposit/acknowledgment";
import { newNonce, signedMessage } from "../../lib/chain/signed-request";
import { DemoHttpError, type AuthEnv } from "../request-auth";
import { handleDepositAck } from "./routes";
import { MemoryDepositAckStore } from "./store";

const NOW = 1_800_000_000_000;
const dev: AuthEnv = { production: false, devWallet: true, verifyToken: async () => null };

function signed(kp: Keypair, step: string, version: string = DEPOSIT_ACK_VERSION) {
  const address = kp.publicKey.toBase58();
  const nonce = newNonce();
  const sig = nacl.sign.detached(new TextEncoder().encode(signedMessage("tesoro-deposit-ack", step, address, NOW, nonce, { version })), kp.secretKey);
  return { step, address, ts: NOW, nonce, version, signature: Buffer.from(sig).toString("base64") };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DemoHttpError ? e.code : String(e);
  }
};

describe("deposit acknowledgment", () => {
  const setup = () => {
    const store = new MemoryDepositAckStore();
    return { store, call: (body: unknown) => handleDepositAck({ store, now: () => NOW }, body, null, dev, NOW) };
  };

  it("is not acknowledged at first, then is after confirm", async () => {
    const { call, store } = setup();
    const kp = Keypair.generate();
    expect(await call(signed(kp, "status"))).toEqual({ acknowledged: false });
    expect(await call(signed(kp, "confirm"))).toEqual({ acknowledged: true });
    expect(await call(signed(kp, "status"))).toEqual({ acknowledged: true });
    expect(store.rows.get(`${kp.publicKey.toBase58()}|${DEPOSIT_ACK_VERSION}`)).toBe(new Date(NOW).toISOString());
  });

  it("keeps Accounts apart and the first time on a repeat confirm", async () => {
    const { call, store } = setup();
    const a = Keypair.generate();
    await call(signed(a, "confirm"));
    expect(await call(signed(Keypair.generate(), "status"))).toEqual({ acknowledged: false });
    await handleDepositAck({ store, now: () => NOW + 5000 }, signed(a, "confirm"), null, dev, NOW);
    expect(store.rows.get(`${a.publicKey.toBase58()}|${DEPOSIT_ACK_VERSION}`)).toBe(new Date(NOW).toISOString());
  });

  it("rejects another wording version and stores nothing", async () => {
    const { call, store } = setup();
    const kp = Keypair.generate();
    expect(await code(call(signed(kp, "confirm", "1999-01-01")))).toBe("wrong-version");
    expect(await code(call(signed(kp, "status", "1999-01-01")))).toBe("wrong-version");
    expect(store.rows.size).toBe(0);
  });

  it("refuses a version swapped after signing, bad signatures, replays and unknown steps", async () => {
    const { call, store } = setup();
    const kp = Keypair.generate();
    const other = Keypair.generate();
    const ok = signed(kp, "confirm");
    expect(await code(call({ ...signed(kp, "confirm", "1999-01-01"), version: DEPOSIT_ACK_VERSION }))).toBe("bad-signature");
    expect(await code(call({ ...ok, signature: undefined }))).toBe("bad-request");
    expect(await code(call({ ...signed(kp, "confirm"), address: other.publicKey.toBase58() }))).not.toBe("ok");
    expect(await code(call({ ...signed(kp, "status"), step: "confirm" }))).not.toBe("ok");
    expect(await code(call(signed(kp, "delete")))).toBe("bad-request");
    expect(store.rows.size).toBe(0);
    expect(await code(call(ok))).toBe("ok");
    expect(await code(call(ok))).not.toBe("ok");
  });
});
