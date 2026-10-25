import { describe, expect, it } from "vitest";
import { FIELD, SealLedger, SealLocked, digInPlain, sealDeclare, sealPad, switchPlain, type SealedEntry } from "./seal";

/** The Rust test `engine::tests::the_pad_follows_the_published_recipe` pins these: key = bytes 0..31, battle = 0xB0 + (i % 16). */
const KEY = Uint8Array.from({ length: 32 }, (_, i) => i);
const BATTLE = Uint8Array.from({ length: 32 }, (_, i) => 0xb0 + (i % 16));

describe("the pad follows the program's published recipe", () => {
  it.each([
    [0, 0, FIELD.digIn, 78],
    [0, 0, FIELD.switch, 96],
    [1, 5, FIELD.digIn, 161],
    [1, 5, FIELD.switch, 137],
    [1, 0x01020304, FIELD.switch, 190],
  ] as const)("seat %i, seq %i, field %i -> %i", async (seat, seq, field, want) => {
    expect(await sealPad(KEY, BATTLE, seat, seq, field)).toBe(want);
  });

  it("depends on the key, the Battle, the seat, the seq and the field", async () => {
    const base = await sealPad(KEY, BATTLE, 0, 7, FIELD.switch);
    const other = [
      await sealPad(Uint8Array.from(KEY, (b) => b ^ 1), BATTLE, 0, 7, FIELD.switch),
      await sealPad(KEY, Uint8Array.from(BATTLE, (b) => b ^ 1), 0, 7, FIELD.switch),
      await sealPad(KEY, BATTLE, 1, 7, FIELD.switch),
      await sealPad(KEY, BATTLE, 0, 8, FIELD.switch),
      await sealPad(KEY, BATTLE, 0, 7, FIELD.digIn),
    ];
    // one byte each: all five differing from the base by chance has a vanishing probability for this fixed input
    expect(other.filter((b) => b !== base).length).toBeGreaterThanOrEqual(4);
  });

  it("refuses a key or a Battle address that is not 32 bytes", async () => {
    await expect(sealPad(new Uint8Array(31), BATTLE, 0, 0, FIELD.switch)).rejects.toThrow();
    await expect(sealPad(KEY, new Uint8Array(33), 0, 0, FIELD.switch)).rejects.toThrow();
  });
});

describe("the plaintexts", () => {
  it("is 0 for no switch and the army slot + 1 for the General of the Army", () => {
    expect(switchPlain(false, 12)).toBe(0);
    expect(switchPlain(true, null)).toBe(0);
    expect(switchPlain(true, 12)).toBe(13);
    expect(switchPlain(true, 41)).toBe(12); // a US piece number maps to its army slot (id % 30)
  });
  it("is 0 for a plain pass and the Major's army slot + 1 for a Dig in", () => {
    expect(digInPlain(null)).toBe(0);
    expect(digInPlain(0)).toBe(1);
    expect(digInPlain(59)).toBe(30);
  });
});

const ledger = (calls: { n: number } = { n: 0 }, store?: ConstructorParameters<typeof SealLedger>[1]) =>
  new SealLedger(async (seq, field) => {
    calls.n++;
    return sealPad(KEY, BATTLE, 0, seq, field);
  }, store);

describe("one plaintext per sequence number", () => {
  it("resends exactly the same sealed byte for a seq on every retry", async () => {
    const calls = { n: 0 };
    const l = ledger(calls);
    const first = await l.seal(5, FIELD.switch, 13);
    expect(await l.seal(5, FIELD.switch, 13)).toBe(first);
    expect(await l.seal(5, FIELD.switch, 13)).toBe(first);
    expect(calls.n).toBe(1);
    expect(first).toBe(13 ^ (await sealPad(KEY, BATTLE, 0, 5, FIELD.switch)));
  });

  it("never seals a second, different plaintext under the same seq and field", async () => {
    const l = ledger();
    await l.seal(5, FIELD.switch, 0);
    await expect(l.seal(5, FIELD.switch, 13)).rejects.toBeInstanceOf(SealLocked);
    // the other field of the same seq is a different pad: free to seal once
    await expect(l.seal(5, FIELD.digIn, 4)).resolves.toBeTypeOf("number");
    await expect(l.seal(5, FIELD.digIn, 5)).rejects.toBeInstanceOf(SealLocked);
  });

  it("holds when two taps race: the second never seals another plaintext", async () => {
    const l = ledger();
    const a = l.seal(9, FIELD.switch, 0);
    const b = l.seal(9, FIELD.switch, 13);
    await expect(b).rejects.toBeInstanceOf(SealLocked);
    await a;
    expect(await l.seal(9, FIELD.switch, 0)).toBe(await a);
  });

  it("a new seq is a new pad: the next turn may choose differently", async () => {
    const l = ledger();
    const a = await l.seal(5, FIELD.switch, 0);
    const b = await l.seal(6, FIELD.switch, 13);
    expect(a).toBe(await sealPad(KEY, BATTLE, 0, 5, FIELD.switch));
    expect(b).toBe(13 ^ (await sealPad(KEY, BATTLE, 0, 6, FIELD.switch)));
  });

  it("forgets seqs the Battle has moved past, and only those", async () => {
    const l = ledger();
    await l.seal(5, FIELD.switch, 0);
    await l.seal(6, FIELD.switch, 0);
    l.forgetBefore(6);
    // 5 is gone (a stale seq is never sent again, so its slot may be reused by a bug-free caller), 6 is kept
    await expect(l.seal(6, FIELD.switch, 13)).rejects.toBeInstanceOf(SealLocked);
    await expect(l.seal(5, FIELD.switch, 13)).resolves.toBeTypeOf("number");
  });

  it("keeps what it sealed across a reload of the page", async () => {
    let saved: SealedEntry[] = [];
    const store = { load: () => saved, save: (e: SealedEntry[]) => (saved = e) };
    const l1 = ledger({ n: 0 }, store);
    const sealed = await l1.seal(7, FIELD.switch, 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(saved).toEqual([{ seq: 7, field: FIELD.switch, plain: 0, sealed }]);
    const calls = { n: 0 };
    const l2 = ledger(calls, store); // the page reloaded: a new ledger loads the entries
    expect(await l2.seal(7, FIELD.switch, 0)).toBe(sealed);
    await expect(l2.seal(7, FIELD.switch, 13)).rejects.toBeInstanceOf(SealLocked);
    expect(calls.n).toBe(0);
  });
});

describe("sealing a declare from the Army", () => {
  // slot 12 holds the unswitched General of the Army (10); slot 3 a Major (7)
  const army = { ranks: Array.from({ length: 30 }, (_, i) => (i === 12 ? 10 : i === 3 ? 7 : 1)) };

  it("seals the switch byte of a move: 0 without Become a Spy, slot + 1 with it", async () => {
    const l = ledger();
    const none = await sealDeclare(l, 4, army, { spy: false, withSlot: false, digIn: null });
    expect(none).toEqual({ expectedSeq: 4, sealedSwitch: 0 ^ (await sealPad(KEY, BATTLE, 0, 4, FIELD.switch)), sealedSlot: 0 });
    const spy = await sealDeclare(ledger(), 4, army, { spy: true, withSlot: false, digIn: null });
    expect(spy.sealedSwitch).toBe(13 ^ (await sealPad(KEY, BATTLE, 0, 4, FIELD.switch)));
  });

  it("a pass always carries both bytes; a Dig in and a plain pass differ only inside the sealed slot byte", async () => {
    const plain = await sealDeclare(ledger(), 4, army, { spy: false, withSlot: true, digIn: null });
    const dig = await sealDeclare(ledger(), 4, army, { spy: false, withSlot: true, digIn: 33 }); // piece 33 = army slot 3
    expect(plain.sealedSwitch).toBe(dig.sealedSwitch);
    expect(dig.sealedSlot).toBe(4 ^ (await sealPad(KEY, BATTLE, 0, 4, FIELD.digIn)));
    expect(plain.sealedSlot).toBe(0 ^ (await sealPad(KEY, BATTLE, 0, 4, FIELD.digIn)));
  });

  it("a retry of the same declare resends identical bytes, and a changed mind in the same turn is refused", async () => {
    const l = ledger();
    const a = await sealDeclare(l, 4, army, { spy: true, withSlot: false, digIn: null });
    expect(await sealDeclare(l, 4, army, { spy: true, withSlot: false, digIn: null })).toEqual(a);
    await expect(sealDeclare(l, 4, army, { spy: false, withSlot: false, digIn: null })).rejects.toBeInstanceOf(SealLocked);
    // the next turn's seq seals fresh
    await expect(sealDeclare(l, 6, army, { spy: false, withSlot: false, digIn: null })).resolves.toMatchObject({ expectedSeq: 6 });
  });

  it("a General of the Army already switched (code 14) or dead has no slot to name: the switch byte is plaintext 0", async () => {
    const switched = { ranks: army.ranks.map((r) => (r === 10 ? 14 : r)) };
    const out = await sealDeclare(ledger(), 4, switched, { spy: true, withSlot: false, digIn: null });
    expect(out.sealedSwitch).toBe(0 ^ (await sealPad(KEY, BATTLE, 0, 4, FIELD.switch)));
  });
});
