import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { afterAll, describe, expect, it } from "vitest";
import { evmPrivateKey, solanaKeypair } from "./keys";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tesoro-secrets-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const keyJson = (kp: Keypair) => JSON.stringify(Array.from(kp.secretKey));
const writeKey = (name: string, kp: Keypair) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, keyJson(kp));
  return file;
};

describe("solanaKeypair", () => {
  it("reads the env secret first, ignoring the file", () => {
    const secret = Keypair.generate();
    const file = writeKey("a.json", Keypair.generate());
    const kp = solanaKeypair("S", "F", "unused", { S: `  ${keyJson(secret)}\n`, F: file });
    expect(kp.publicKey.equals(secret.publicKey)).toBe(true);
  });

  it("falls back to the file at the path variable when the secret is unset or empty", () => {
    const onDisk = Keypair.generate();
    const file = writeKey("b.json", onDisk);
    expect(solanaKeypair("S", "F", "unused", { F: file }).publicKey.equals(onDisk.publicKey)).toBe(true);
    expect(solanaKeypair("S", "F", "unused", { S: "", F: file }).publicKey.equals(onDisk.publicKey)).toBe(true);
  });

  it("falls back to ~/<fallback> when neither is set", () => {
    const onDisk = Keypair.generate();
    writeKey("c.json", onDisk);
    const rel = path.relative(os.homedir(), path.join(dir, "c.json"));
    expect(solanaKeypair("S", "F", rel, {}).publicKey.equals(onDisk.publicKey)).toBe(true);
  });

  it("rejects a malformed secret without quoting it and without falling back to the file", () => {
    const file = writeKey("d.json", Keypair.generate());
    const bad = "[1,2,3,not-a-key-ZZZ]";
    expect(() => solanaKeypair("S", "F", "unused", { S: bad, F: file })).toThrow(/^S is not a Solana keypair/);
    try {
      solanaKeypair("S", "F", "unused", { S: bad });
    } catch (e) {
      expect((e as Error).message).not.toContain("ZZZ");
    }
  });

  it("throws when nothing is configured", () => {
    expect(() => solanaKeypair("S", "F", "unused", { F: path.join(dir, "missing.json") })).toThrow();
  });
});

describe("evmPrivateKey", () => {
  const key = () => `0x${randomBytes(32).toString("hex")}`;

  it("reads the env secret first", () => {
    const k = key();
    expect(evmPrivateKey("S", "F", "unused", "RELAYER_EVM_PRIVATE_KEY", { S: k, F: path.join(dir, "missing.env") })).toBe(k);
  });

  it("falls back to the KEY= line of the env file", () => {
    const k = key();
    const file = path.join(dir, "relayer.env");
    fs.writeFileSync(file, `# comment\nOTHER=1\nRELAYER_EVM_PRIVATE_KEY=${k}\n`);
    expect(evmPrivateKey("S", "F", "unused", "RELAYER_EVM_PRIVATE_KEY", { F: file })).toBe(k);
  });

  it("rejects a malformed secret without quoting it", () => {
    expect(() => evmPrivateKey("S", "F", "unused", "K", { S: "0xZZZ" })).toThrow(/^S is not an EVM private key \(expected 0x \+ 64 hex\)$/);
  });

  it("throws when the env file has no such key", () => {
    const file = path.join(dir, "empty.env");
    fs.writeFileSync(file, "OTHER=1\n");
    expect(() => evmPrivateKey("S", "F", "unused", "RELAYER_EVM_PRIVATE_KEY", { F: file })).toThrow(/has no RELAYER_EVM_PRIVATE_KEY/);
  });
});
