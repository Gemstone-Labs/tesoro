import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { bookPda, ckptPda, CLASS_STUDIO } from "./basket";
import { encodeBook, freshClass } from "./basket-fixture";
import { fp } from "./book";
import { accountPda, redeemIx, simSolAta } from "./native";
import { landingPageNumbers, landingPlan, redeemLineIxs, sourceAccounts } from "./redeem";
import { decodeBook } from "./book";

const source = Keypair.generate().publicKey;
const me = Keypair.generate().publicKey;
const owing = (ck: number) => ({ ...freshClass(), uncovered: fp(100n), w: fp(100n), ck });
const book = (generalCk: number, studioCk = 0) => encodeBook([freshClass(), { ...owing(studioCk) }, freshClass(), owing(generalCk)]);

/** Accounts by address; anything not listed does not exist. */
const chain = (accounts: Map<string, Buffer>) => ({ getMultipleAccountsInfo: async (keys: PublicKey[]) => keys.map((k) => (accounts.has(k.toBase58()) ? { data: accounts.get(k.toBase58())! } : null)) });

describe("landing pages", () => {
  it("lists, per class with Gemas still unpaid, the page of the next record and the next one", () => {
    const pages = landingPageNumbers(decodeBook(book(30, 0)));
    // Studio (ck 0): page 0; General (ck 30): pages 0 and 1 (30 + 3 records crosses page 32)
    expect(pages).toEqual([
      { classId: CLASS_STUDIO, page: 0 },
      { classId: 3, page: 0 },
      { classId: 3, page: 1 },
    ]);
  });

  it("skips fully repaid and pooled fee classes", () => {
    expect(landingPageNumbers(decodeBook(encodeBook([{ ...owing(0) }, freshClass(), { ...owing(0) }, freshClass()])))).toEqual([]);
  });

  it("creates the pages that do not exist and passes the ones that do", async () => {
    const have = new Map<string, Buffer>([
      [bookPda(source).toBase58(), book(30)],
      [ckptPda(source, 3, 0).toBase58(), Buffer.alloc(4)],
    ]);
    const plan = await landingPlan(chain(have), source, me);
    expect(plan.create).toHaveLength(2);
    expect(plan.accounts.map((a) => a.toBase58())).toEqual([ckptPda(source, CLASS_STUDIO, 0), ckptPda(source, 3, 0), ckptPda(source, 3, 1)].map((a) => a.toBase58()));
  });

  it("passes the book first and each account once", async () => {
    const have = new Map<string, Buffer>([[bookPda(source).toBase58(), book(0)]]);
    const known = ckptPda(source, 3, 0);
    const { accounts } = await sourceAccounts(chain(have), source, [bookPda(source), known], me);
    expect(accounts[0].equals(bookPda(source))).toBe(true);
    expect(new Set(accounts.map((a) => a.toBase58())).size).toBe(accounts.length);
  });
});

describe("Redeem of a line", () => {
  const h = { line: { side: 1, dueAt: 9n, class: 3, tranche: 0 }, accounts: [] as PublicKey[], source, position: Keypair.generate().publicKey, stakeMint: null };

  it("creates the token account only when it is missing", async () => {
    const base = new Map<string, Buffer>([[bookPda(source).toBase58(), book(0)]]);
    const withAta = new Map(base).set(simSolAta(me).toBase58(), Buffer.alloc(165));
    const missing = await redeemLineIxs(chain(base), me, h, 5n);
    const present = await redeemLineIxs(chain(withAta), me, h, 5n);
    // class pages (Studio 0, General 0) + the token account + redeem, against redeem alone with the pages created
    expect(missing.length).toBe(present.length + 1);
    expect(present.at(-1)!.programId.toBase58()).toBe(redeemIx(me, h.position, source, 5n, h).programId.toBase58());
  });

  it("passes the book and the pages the landing needs to the redeem", async () => {
    const have = new Map<string, Buffer>([
      [bookPda(source).toBase58(), book(0)],
      [simSolAta(me).toBase58(), Buffer.alloc(165)],
      [ckptPda(source, CLASS_STUDIO, 0).toBase58(), Buffer.alloc(4)],
      [ckptPda(source, 3, 0).toBase58(), Buffer.alloc(4)],
    ]);
    const ixs = await redeemLineIxs(chain(have), me, h, 5n);
    expect(ixs).toHaveLength(1);
    const keys = ixs[0].keys.map((k) => k.pubkey.toBase58());
    expect(keys).toContain(bookPda(source).toBase58());
    expect(keys).toContain(ckptPda(source, 3, 0).toBase58());
    expect(keys[1]).toBe(accountPda(me).toBase58());
  });
});
