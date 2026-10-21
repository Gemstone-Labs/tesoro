import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { newNonce, signedMessage } from "@/lib/chain/signed-request";
import { NonceStore, verifySignedRequest } from "../request-auth";
import { parseIntentText } from "./intent";

const env = { privyAppId: undefined, production: false, devWallet: true, verifyToken: async () => null };

describe("the build request is signed over the whole intent", () => {
  const kp = Keypair.generate();
  const intent = JSON.stringify({ ixs: [{ program: "x", keys: [], data: "AQ==" }] });
  const request = (fields: { intent: string }, signedFields = fields) => {
    const ts = Date.now();
    const nonce = newNonce();
    const signature = Buffer.from(nacl.sign.detached(new TextEncoder().encode(signedMessage("tesoro-sponsor", "build", kp.publicKey.toBase58(), ts, nonce, signedFields)), kp.secretKey)).toString("base64");
    return { step: "build", address: kp.publicKey.toBase58(), ts, nonce, signature, ...fields };
  };
  const verify = (body: unknown) => verifySignedRequest("tesoro-sponsor", ["build"] as const, body, null, { nonces: new NonceStore(), env });

  it("accepts it and hands the intent text back", async () => {
    const r = await verify(request({ intent }));
    expect(parseIntentText(r.fields.intent)).toEqual(JSON.parse(intent));
  });
  it("refuses an intent changed after signing", async () => {
    await expect(verify(request({ intent: intent.replace("AQ==", "Ag==") }, { intent }))).rejects.toMatchObject({ code: "bad-signature" });
  });
  it("refuses an intent that is not JSON", () => {
    expect(() => parseIntentText("{nope")).toThrowError(expect.objectContaining({ code: "bad-request" }));
  });
});
