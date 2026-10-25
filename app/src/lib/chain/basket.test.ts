import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { compareKeys, decodeStore, freeGemas, SIDE_OWN, SIDE_WON, CLASS_STUDIO } from "./basket";
import { decodeBook, fp, landPreview, P_ONE, readyNow, redeemableNow, syncPreview, uncoveredNow, uncoveredTotal, debtGemasOf } from "./book";
import { encodeBook, encodeStore, freshClass, lineOf } from "./basket-fixture";
import { DrawError, planDraw, sourcesTouched } from "./draw";

const srcA = new Keypair().publicKey;
const srcB = new Keypair().publicKey;
const [lo, hi] = [srcA, srcB].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));

describe("store decoding", () => {
  it("round-trips lines in key order and reports totals", () => {
    const lines = [
      lineOf({ source: hi, amount: 40n, side: SIDE_WON, dueAt: 5n }),
      lineOf({ source: lo, amount: 100n, dueAt: 20n }),
      lineOf({ source: hi, amount: 7n, dueAt: 10n }),
      lineOf({ source: lo, amount: 3n, classId: CLASS_STUDIO }),
    ];
    const store = decodeStore(encodeStore(lines, { capacity: 10, first: 2 }));
    expect(store.lines).toHaveLength(4);
    expect(store.header).toMatchObject({ ownTotal: 107n, wonTotal: 40n, feeTotal: 3n, capacity: 10, first: 2, len: 4 });
    for (let i = 1; i < store.lines.length; i++) expect(compareKeys(store.lines[i - 1], store.lines[i])).toBeLessThan(0);
    expect(store.lines[0].side).toBe(SIDE_OWN);
    expect(store.lines.at(-1)?.side).toBe(SIDE_WON);
  });

  it("refuses an unknown version", () => {
    const data = encodeStore([]);
    data[8] = 9;
    expect(() => decodeStore(data)).toThrow(/version/);
  });
});

describe("entry draw preview", () => {
  const basket = decodeStore(encodeStore([lineOf({ source: lo, amount: 300n, dueAt: 50n }), lineOf({ source: hi, amount: 200n, dueAt: 10n }), lineOf({ source: lo, amount: 90n, side: SIDE_WON, dueAt: 5n })]));
  const spill = decodeStore(encodeStore([lineOf({ source: lo, amount: 25n, dueAt: 30n })]));

  it("takes own Gemas first, the fastest (earliest due) line first, across basket and spill", () => {
    const plan = planDraw(basket, spill, 300n);
    expect(plan.steps.map((s) => [s.key.dueAt, s.take, s.whole])).toEqual([
      [10n, 200n, true],
      [30n, 25n, true],
      [50n, 75n, false],
    ]);
    expect(plan.potLines).toBe(3);
    expect(plan.needsTicket).toBe(false);
    expect(sourcesTouched(plan).map((k) => k.toBase58())).toEqual([lo.toBase58()]);
  });

  it("falls through to won Gemas after the own side", () => {
    const plan = planDraw(basket, null, 550n);
    expect(plan.steps.at(-1)?.key.side).toBe(SIDE_WON);
  });

  it("refuses more than the free Gemas and counts reservations out", () => {
    expect(() => planDraw(basket, spill, 616n)).toThrow(DrawError);
    const reserved = decodeStore(encodeStore([lineOf({ source: lo, amount: 100n })], { reservedTotal: 60n, ticketNeed: 10n }));
    expect(freeGemas(reserved, null)).toBe(30n);
    expect(() => planDraw(reserved, null, 31n)).toThrow(/Not enough/);
    expect(() => planDraw(reserved, null, 0n)).toThrow(/at least 1/);
  });

  it("needs a Ticket past 16 lines", () => {
    const many = decodeStore(encodeStore(Array.from({ length: 20 }, (_, i) => lineOf({ source: lo, amount: 10n, dueAt: BigInt(i) }))));
    expect(planDraw(many, null, 160n).needsTicket).toBe(false);
    expect(planDraw(many, null, 170n).needsTicket).toBe(true);
  });
});

describe("Source book reading", () => {
  it("shows a line's unpaid amount scaled by its class index", () => {
    const line = lineOf({ source: lo, amount: 100n, uncovered: fp(100n) });
    const cls = { ...freshClass(), uncovered: fp(100n), w: fp(100n), p: P_ONE / 2n };
    expect(uncoveredNow(cls, line)).toBe(fp(50n));
    expect(uncoveredNow({ ...cls, epoch: 1, p: P_ONE }, line)).toBe(0n);
  });

  it("decodes a book and lands coverage class by class, keeping ready + unpaid = amount", () => {
    const studio = { ...freshClass(), uncovered: fp(30n), w: fp(30n) };
    const general = { ...freshClass(), uncovered: fp(970n), w: fp(970n) };
    const book = decodeBook(encodeBook([freshClass(), studio, freshClass(), general]));
    expect(uncoveredTotal(book)).toBe(fp(1000n));
    const studioLine = lineOf({ source: lo, amount: 30n, classId: CLASS_STUDIO, uncovered: fp(30n) });
    const line = lineOf({ source: lo, amount: 970n, uncovered: fp(970n) });
    // 250 Gemas land: the Studio class (senior) is paid first
    const after = landPreview(book, fp(250n));
    expect(after.classes[1].uncovered).toBe(0n);
    expect(after.classes[1].epoch).toBe(1);
    expect(after.classes[3].uncovered).toBe(fp(750n));
    expect(readyNow(after, studioLine)).toBe(fp(30n));
    expect(redeemableNow(after, line)).toBeGreaterThanOrEqual(219n);
    expect(redeemableNow(after, line)).toBeLessThanOrEqual(220n);
    expect(readyNow(after, line) + after.classes[3].uncovered).toBeLessThanOrEqual(fp(970n));
    expect(debtGemasOf(after)).toBe(750n);
  });

  it("the sum of every line's ready stays within the class's ready after a partial landing", () => {
    const u = fp(1000n);
    const general = { ...freshClass(), uncovered: u, w: u };
    const book = decodeBook(encodeBook([freshClass(), freshClass(), freshClass(), general]));
    const lines = [300n, 700n].map((a) => lineOf({ source: lo, amount: a, uncovered: fp(a) }));
    const after = landPreview(book, fp(333n) + 12345n);
    const ready = lines.reduce((s, l) => s + readyNow(after, l), 0n);
    expect(ready).toBeLessThanOrEqual(after.classes[3].ready);
    expect(ready).toBeGreaterThan(after.classes[3].ready - 4n);
    expect(after.classes[3].ready).toBe(fp(333n) + 12345n);
  });

  it("converts the open Advance's counted units to coverage at the Source's price and forgives dust", () => {
    const general = { ...freshClass(), uncovered: fp(100n), w: fp(100n) };
    const book = decodeBook(encodeBook([freshClass(), freshClass(), freshClass(), general]));
    // 1 Gema = 2,000,000 / 100 base units
    const unit = { unitNum: 20_000n, unitDen: 1n };
    const half = syncPreview(book, 1_000_000n, unit);
    expect(half.h).toBe(fp(50n));
    expect(uncoveredTotal(half)).toBe(fp(50n));
    const nearlyAll = syncPreview(book, 1_999_999n, unit);
    expect(nearlyAll.h).toBe(fp(99n) + (fp(1n) * 19_999n) / 20_000n);
    const dust = syncPreview(book, 2_000_000n, unit);
    expect(uncoveredTotal(dust)).toBe(0n);
  });
});
