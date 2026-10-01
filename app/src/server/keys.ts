/**
 * Server keys from env secrets, with the key files under ~/.config/tesoro as the local fallback.
 * Hosts without those files (Vercel) set the secret; see app/docs/hosting.md. Values never leave
 * this module except as a Keypair or private key, and errors never quote them.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import type { Hex } from "viem";

type Env = Record<string, string | undefined>;

/** Swept on 2026-10-01 (`~/.config/solana/id.json`): never sign with it. */
const COMPROMISED = "AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV";

const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;

function parseKeypair(raw: string, from: string): Keypair {
  let kp: Keypair;
  try {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  } catch {
    throw new Error(`${from} is not a Solana keypair (expected the keypair file's JSON array of 64 bytes)`);
  }
  if (kp.publicKey.toBase58() === COMPROMISED) throw new Error(`${from} is the compromised key ${COMPROMISED}; refusing to sign with it`);
  return kp;
}

/**
 * The env secret `secretVar` (the keypair file's contents, a JSON array of 64 bytes) when set, else the
 * file at `fileVar`, else `~/<fallback>`. A malformed secret throws instead of falling back to a file.
 */
export function solanaKeypair(secretVar: string, fileVar: string, fallback: string, env: Env = process.env): Keypair {
  const secret = env[secretVar]?.trim();
  if (secret) return parseKeypair(secret, secretVar);
  const file = env[fileVar] || path.join(os.homedir(), fallback);
  return parseKeypair(fs.readFileSync(file, "utf8"), file);
}

/**
 * The env secret `secretVar` (0x + 64 hex) when set, else the `fileKey=` line of the env file at
 * `fileVar`, else of `~/<fallback>`.
 */
export function evmPrivateKey(secretVar: string, fileVar: string, fallback: string, fileKey: string, env: Env = process.env): Hex {
  const secret = env[secretVar]?.trim();
  if (secret) {
    if (!HEX_KEY.test(secret)) throw new Error(`${secretVar} is not an EVM private key (expected 0x + 64 hex)`);
    return secret as Hex;
  }
  const file = env[fileVar] || path.join(os.homedir(), fallback);
  const m = new RegExp(`^${fileKey}=(0x[0-9a-fA-F]{64})\\s*$`, "m").exec(fs.readFileSync(file, "utf8"));
  if (!m) throw new Error(`${file} has no ${fileKey}`);
  return m[1] as Hex;
}
