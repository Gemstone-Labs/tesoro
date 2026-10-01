import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { evmKeyFromEnv, keypairFromEnv } from "./keys.ts";

describe("keypairFromEnv", () => {
  it("parses the keypair file's JSON array", () => {
    const kp = Keypair.generate();
    const got = keypairFromEnv("K", { K: ` ${JSON.stringify(Array.from(kp.secretKey))}\n` });
    assert.ok(got?.publicKey.equals(kp.publicKey));
  });

  it("is undefined when unset or empty, so the caller falls back to its file", () => {
    assert.equal(keypairFromEnv("K", {}), undefined);
    assert.equal(keypairFromEnv("K", { K: "  " }), undefined);
  });

  it("rejects a malformed value without quoting it", () => {
    assert.throws(() => keypairFromEnv("K", { K: "[1,2,SECRETISH]" }), (e: Error) => /^K is not a Solana keypair/.test(e.message) && !e.message.includes("SECRETISH"));
  });
});

describe("evmKeyFromEnv", () => {
  it("accepts 64 hex digits with or without 0x", () => {
    const hex = randomBytes(32).toString("hex");
    assert.equal(evmKeyFromEnv("E", { E: hex }), `0x${hex}`);
    assert.equal(evmKeyFromEnv("E", { E: `0x${hex}` }), `0x${hex}`);
    assert.equal(evmKeyFromEnv("E", {}), undefined);
  });

  it("rejects a malformed value without quoting it", () => {
    assert.throws(() => evmKeyFromEnv("E", { E: "0xSECRETISH" }), (e: Error) => !e.message.includes("SECRETISH"));
  });
});
