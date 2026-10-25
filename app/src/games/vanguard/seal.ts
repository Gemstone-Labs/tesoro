/**
 * Sealing of the secret powers (programs/vanguard `engine::seal_pad`). A declare carries a switch byte (Become a Spy)
 * and, on a pass, a Dig in slot byte, each XORed with a one-byte pad only this Player can compute:
 *
 *   pad(field) = SHA-256("vanguard-seal-v1" || key(32) || battle(32) || seat(1) || seq(u32 LE) || field(1))[0]
 *
 * The key is the Player's own Army `reserved` bytes. One byte of pad is perfect secrecy for one plaintext only: a
 * second, different plaintext sealed under the same (key, seq, field) would hand the pad to anyone who sees both. So
 * the ledger below keeps what was sealed per (seq, field) and refuses a different plaintext for the same slot. A
 * retry resends the very same bytes; changing your mind waits for the next turn's seq.
 */

const LABEL = new TextEncoder().encode("vanguard-seal-v1");

/** `field` of the pad: 1 seals the Dig in slot, 2 seals the switch. */
export const FIELD = { digIn: 1, switch: 2 } as const;
export type SealField = (typeof FIELD)[keyof typeof FIELD];

/** The pad byte for one field of the declare at `seq`. */
export async function sealPad(key: ArrayLike<number>, battle: Uint8Array, seat: number, seq: number, field: SealField): Promise<number> {
  if (key.length !== 32 || battle.length !== 32) throw new Error("seal: key and Battle address are 32 bytes each");
  const msg = new Uint8Array(LABEL.length + 32 + 32 + 1 + 4 + 1);
  let at = 0;
  msg.set(LABEL, at);
  at += LABEL.length;
  msg.set(Array.from(key), at);
  at += 32;
  msg.set(battle, at);
  at += 32;
  msg[at++] = seat & 0xff;
  new DataView(msg.buffer).setUint32(at, seq >>> 0, true);
  at += 4;
  msg[at] = field;
  const digest = await globalThis.crypto.subtle.digest("SHA-256", msg);
  return new Uint8Array(digest)[0];
}

/** The plaintext of the switch byte: 0 = none, else the army slot of the General of the Army + 1. */
export const switchPlain = (on: boolean, tenId: number | null): number => (on && tenId !== null ? (tenId % 30) + 1 : 0);

/** The plaintext of the Dig in byte: 0 = a plain pass, else the army slot of the Major + 1. */
export const digInPlain = (majorId: number | null): number => (majorId === null ? 0 : (majorId % 30) + 1);

/** A different plaintext was asked for under a (seq, field) that already sealed one. */
export class SealLocked extends Error {
  constructor(readonly seq: number, readonly field: SealField) {
    super("That choice is already sent for this turn. Try again next turn.");
    this.name = "SealLocked";
  }
}

export interface SealedEntry {
  seq: number;
  field: SealField;
  plain: number;
  sealed: number;
}

/**
 * What one Player has sealed in a Match, by (seq, field). `store` (optional) keeps the entries across a reload of the
 * page: a declare that did not land leaves the seq unchanged, so a reload before the retry must not forget what was
 * sealed. A stale entry is harmless; it is dropped once the seq has moved on.
 */
export class SealLedger {
  private readonly sealed = new Map<string, { plain: number; byte: Promise<number> }>();

  constructor(
    private readonly pad: (seq: number, field: SealField) => Promise<number>,
    private readonly store?: { load: () => SealedEntry[]; save: (entries: SealedEntry[]) => void },
  ) {
    for (const e of store?.load() ?? []) this.sealed.set(`${e.seq}:${e.field}`, { plain: e.plain, byte: Promise.resolve(e.sealed) });
  }

  /** The sealed byte for `plain`, the same bytes every time for this (seq, field). A different plaintext throws `SealLocked`. */
  seal(seq: number, field: SealField, plain: number): Promise<number> {
    const k = `${seq}:${field}`;
    const had = this.sealed.get(k);
    if (had) return had.plain === plain ? had.byte : Promise.reject(new SealLocked(seq, field));
    // recorded before the pad arrives, so two quick taps can never seal two plaintexts
    const byte = this.pad(seq, field).then((p) => (plain ^ p) & 0xff);
    this.sealed.set(k, { plain, byte });
    byte.then(
      () => this.save(),
      () => this.sealed.delete(k),
    );
    return byte;
  }

  /** Forget everything sealed for seqs before `seq`: they can never be sent again (the program refuses a stale seq). */
  forgetBefore(seq: number): void {
    let dropped = false;
    for (const k of this.sealed.keys()) {
      if (Number(k.split(":")[0]) < seq) {
        this.sealed.delete(k);
        dropped = true;
      }
    }
    if (dropped) this.save();
  }

  private save(): void {
    if (!this.store) return;
    void Promise.all(
      [...this.sealed].map(async ([k, v]) => {
        const [seq, field] = k.split(":").map(Number);
        return { seq, field: field as SealField, plain: v.plain, sealed: await v.byte };
      }),
    ).then((entries) => this.store?.save(entries), () => undefined);
  }
}

/** The sealed fields of one declare, as `chain.ts` sends them. `sealedSlot` is 0 (unused) except on a pass. */
export interface SealedDeclare {
  expectedSeq: number;
  sealedSwitch: number;
  sealedSlot: number;
}

/**
 * Seal one declare at `seq` (the Battle's `action_seq` now). `army` is the Player's own Army: its rank codes say which slot holds
 * the unswitched General of the Army (code 10). `spy` is the Become a Spy choice; `digIn` is the Major's piece number on a Dig in,
 * `null` on a plain pass, and `withSlot` is true for a pass (its slot byte is always sent). The ledger returns the bytes already
 * sealed for this seq when it has them, and throws `SealLocked` when the choice differs.
 */
export async function sealDeclare(
  ledger: SealLedger,
  seq: number,
  army: { ranks: readonly number[] },
  o: { spy: boolean; withSlot: boolean; digIn: number | null },
): Promise<SealedDeclare> {
  ledger.forgetBefore(seq);
  const ten = army.ranks.indexOf(10);
  const sealedSwitch = await ledger.seal(seq, FIELD.switch, switchPlain(o.spy, ten >= 0 ? ten : null));
  const sealedSlot = o.withSlot ? await ledger.seal(seq, FIELD.digIn, digInPlain(o.digIn)) : 0;
  return { expectedSeq: seq, sealedSwitch, sealedSlot };
}
