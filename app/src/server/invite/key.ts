import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

/** The compromised key (see ../keys.ts): never sign with it. */
const COMPROMISED = "AXwYStYVryJuZjNJjHHLPp6eVRc2TuESnW1pCMiUYrwV";

/** INVITE_SECRET_KEY: base58 (64-byte secret) or the keypair file's JSON array. Errors never quote the value. */
export function inviteKeypair(raw: string | undefined): Keypair {
  const value = raw?.trim();
  if (!value) throw new Error("INVITE_SECRET_KEY is not set");
  let bytes: Uint8Array;
  try {
    bytes = value.startsWith("[") ? Uint8Array.from(JSON.parse(value)) : bs58.decode(value);
  } catch {
    throw new Error("INVITE_SECRET_KEY is neither base58 nor a JSON array of bytes");
  }
  let kp: Keypair;
  try {
    kp = Keypair.fromSecretKey(bytes);
  } catch {
    throw new Error("INVITE_SECRET_KEY is not a 64-byte Solana secret key");
  }
  if (kp.publicKey.toBase58() === COMPROMISED) throw new Error("INVITE_SECRET_KEY is the compromised key; refusing to sign with it");
  return kp;
}
