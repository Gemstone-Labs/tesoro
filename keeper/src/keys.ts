import { Keypair } from "@solana/web3.js";

/**
 * Keys from env secrets, for hosts without ~/.config/tesoro. Each returns undefined
 * when its variable is unset, so the caller falls back to its key file. Errors never quote the value.
 */

/** Swept on 2026-10-01 (`~/.config/solana/id.json`): never sign with it. */
const COMPROMISED = "AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV";

/** `name` holds the keypair file's contents: a JSON array of 64 bytes. */
export function keypairFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): Keypair | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  let kp: Keypair;
  try {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(value)));
  } catch {
    throw new Error(`${name} is not a Solana keypair (expected the keypair file's JSON array of 64 bytes)`);
  }
  if (kp.publicKey.toBase58() === COMPROMISED) throw new Error(`${name} is the compromised key ${COMPROMISED}; refusing to sign with it`);
  return kp;
}

/** `name` holds an EVM private key: 64 hex digits, with or without 0x. */
export function evmKeyFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): `0x${string}` | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  const hex = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`${name} is not an EVM private key (expected 64 hex digits)`);
  return hex as `0x${string}`;
}
