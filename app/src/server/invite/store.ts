import { createHash, randomBytes } from "node:crypto";

/** Crockford base32: no I, L, O, U, so a code read aloud or typed from an email survives. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Uppercase, drops spaces and dashes, and reads the look-alikes O, I, L the way Crockford does. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** What the store keeps: the SHA-256 of the normalized code. The code itself is never stored. */
export const hashCode = (raw: string) => createHash("sha256").update(normalizeCode(raw)).digest("hex");

/** 16 characters (80 bits of entropy) as XXXX-XXXX-XXXX-XXXX. Ticket 30 (Invite emails) creates codes with this. */
export function newInviteCode(bytes: Uint8Array = randomBytes(16)): string {
  let out = "";
  for (let i = 0; i < 16; i++) out += ALPHABET[bytes[i] % 32];
  return out.replace(/(.{4})(?=.)/g, "$1-");
}

export type ClaimResult =
  | { state: "claimed"; email: string }
  | { state: "same"; email: string }
  | { state: "other" }
  | { state: "unknown" };

/** The private Invite store: one row per code, off chain. */
export interface InviteStore {
  /** Adds a code (by hash) for `email`. Throws when the hash already exists. */
  create(codeHash: string, email: string): Promise<void>;
  /**
   * Atomically marks an unused code used by `authority`. "same": already used by this authority.
   * "other": used by another. "unknown": no such code.
   */
  claim(codeHash: string, authority: string): Promise<ClaimResult>;
}

export class MemoryInviteStore implements InviteStore {
  readonly rows = new Map<string, { email: string; usedBy: string | null }>();
  async create(codeHash: string, email: string) {
    if (this.rows.has(codeHash)) throw new Error("Invite code already exists");
    this.rows.set(codeHash, { email, usedBy: null });
  }
  async claim(codeHash: string, authority: string): Promise<ClaimResult> {
    const r = this.rows.get(codeHash);
    if (!r) return { state: "unknown" };
    if (r.usedBy === null) {
      r.usedBy = authority;
      return { state: "claimed", email: r.email };
    }
    return r.usedBy === authority ? { state: "same", email: r.email } : { state: "other" };
  }
}
