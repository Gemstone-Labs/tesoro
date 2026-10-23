import { BN, BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import coreIdl from "./idl/tesoro_core.json";
import { bookPda } from "./basket";
import { encodeStore, lineOf, encodeLine } from "./basket-fixture";
import {
  INSTANT_ORDER_LEN,
  cancelInstantRedeemIx,
  decodeOrder,
  expireInstantRedeemIx,
  fillInstantRedeemIxs,
  fillPayoutShares,
  instantOrderPda,
  maxFill,
  orderState,
  parseRoute,
  requestInstantRedeemIx,
} from "./instant-order";
import { NATIVE_CUSTODY_LEN, parseNativeRoute } from "./fees";
import { accountPda } from "./native";

const coder = new BorshAccountsCoder(coreIdl as unknown as Idl);
const key = () => Keypair.generate().publicKey;
const source = key();
const holder = key();
const account = accountPda(holder);
const line = { line: { side: 1, dueAt: 5n, class: 3, tranche: 0 }, accounts: [bookPda(source)], source, position: key(), stakeMint: null, native: true, eth: null };

async function orderAccount(over: Record<string, unknown> = {}) {
  const lineBytes = new Uint8Array(144);
  encodeLine(lineOf({ source, amount: 600n, side: 1, dueAt: 5n }), lineBytes);
  const data = await coder.encode("InstantOrderState", {
    bump: 1,
    nonce: new BN(42),
    account,
    owner: holder,
    line: Array.from(lineBytes),
    requested: new BN(700),
    created_at: new BN(1_000),
    expires_at: new BN(1_000 + 7 * 86_400),
    sold: new BN(100),
    redeemed_while_open: new BN(0),
    paid_shares: new BN(9),
    payer: holder,
    sponsored_lamports: new BN(0),
    ...over,
  });
  return Buffer.from(data);
}

describe("order accounts", () => {
  it("decodes what the program writes", async () => {
    const data = await orderAccount();
    expect(data.length).toBe(INSTANT_ORDER_LEN);
    const o = decodeOrder(key(), data);
    expect(o).toMatchObject({ nonce: 42n, requested: 700n, sold: 100n, createdAt: 1_000, paidShares: 9n, sponsoredLamports: 0n });
    expect(o.account.equals(account)).toBe(true);
    expect(o.owner.equals(holder)).toBe(true);
    expect(o.source.equals(source)).toBe(true);
    expect(o.line.amount).toBe(600n);
    expect(o.payer.equals(holder)).toBe(true);
  });

  it("states: requested, partly sold, expired, finished", async () => {
    const base = decodeOrder(key(), await orderAccount({ sold: new BN(0) }));
    expect(orderState(base, 2_000)).toBe("requested");
    expect(orderState({ ...base, sold: 5n }, 2_000)).toBe("partly-sold");
    expect(orderState(base, base.expiresAt)).toBe("expired");
    expect(orderState({ ...base, line: { ...base.line, amount: 0n } }, 2_000)).toBe("finished");
  });

  it("derives the order address from the Account and the nonce", () => {
    expect(instantOrderPda(account, 1).equals(instantOrderPda(account, 2))).toBe(false);
  });

  it("reads a route's spendable shares: held less owed, pool owed and reserved", () => {
    const d = Buffer.alloc(149);
    d.writeBigUInt64LE(100n, 0);
    d.writeBigUInt64LE(30n, 16);
    d.writeBigUInt64LE(5n, 32);
    d.writeBigUInt64LE(15n, 48);
    expect(parseRoute(d, 0).spendable).toBe(50n);
    d.writeBigUInt64LE(10n, 0);
    expect(parseRoute(d, 0).spendable).toBe(0n);
    const custody = Buffer.alloc(NATIVE_CUSTODY_LEN);
    custody.writeBigUInt64LE(77n, NATIVE_CUSTODY_LEN - 149);
    expect(parseNativeRoute(custody)?.treasuryShares).toBe(77n);
    expect(parseNativeRoute(custody.subarray(1))).toBeNull();
  });
});

describe("the fill budget", () => {
  // 1 Gema = $0.01; SOL at $150: 1 Gema = 10^13 / 150,000,000 lamports; simSOL rate 1.0
  const src = { unitNum: 10n ** 13n, unitDen: 150_000_000n };
  const rate = { scale: 1_000_000_000n, rate: 1_000_000_000n };

  it("pays 75% of the value, floored twice", () => {
    // 1,000 Gemas = 66,666,666 lamports (floored) -> 49,999,999 shares
    expect(fillPayoutShares(1_000n, src, rate)).toEqual({ value: 66_666_666n, payout: 49_999_999n });
  });

  it("buys the most Gemas whose payout fits the budget, never more", () => {
    const spend = 30_000_000n;
    const k = maxFill({ remaining: 5_000n, ready: 0n, spendable: spend, src, rate });
    expect(fillPayoutShares(k, src, rate).payout).toBeLessThanOrEqual(spend);
    expect(fillPayoutShares(k + 1n, src, rate).payout).toBeGreaterThan(spend);
  });

  it("is capped by what is left once the ready Gemas are redeemed to the seller, and is 0 with no budget", () => {
    expect(maxFill({ remaining: 500n, ready: 200n, spendable: 10n ** 12n, src, rate })).toBe(300n);
    expect(maxFill({ remaining: 500n, ready: 900n, spendable: 10n ** 12n, src, rate })).toBe(0n);
    expect(maxFill({ remaining: 500n, ready: 0n, spendable: 0n, src, rate })).toBe(0n);
  });
});

describe("instructions", () => {
  const spec = (name: string) => (coreIdl.instructions as { name: string; accounts: unknown[] }[]).find((i) => i.name === name)!;

  it("request: the order PDA, the sponsor only when sponsored, payout accounts then the book", () => {
    const base = { holder, h: line, sell: 600n, nonce: 7n, book: [bookPda(source)] };
    const own = requestInstantRedeemIx({ ...base, payer: holder, sponsored: false });
    const n = spec("request_instant_redeem").accounts.length;
    expect(own.keys[0].pubkey.equals(holder)).toBe(true);
    expect(own.keys[7].pubkey.equals(instantOrderPda(account, 7n))).toBe(true);
    expect(own.keys[8].pubkey.equals(own.programId)).toBe(true);
    // native paying (9) + book (1)
    expect(own.keys).toHaveLength(n + 9 + 1);
    expect(own.keys.at(-1)!.pubkey.equals(bookPda(source))).toBe(true);
    const relayer = key();
    const sponsored = requestInstantRedeemIx({ ...base, payer: relayer, sponsored: true });
    expect(sponsored.keys[0].pubkey.equals(relayer)).toBe(true);
    expect(sponsored.keys[8].pubkey.equals(own.programId)).toBe(false);
  });

  it("request for an EVM Source carries no payout accounts", () => {
    const evm = { ...line, native: false, eth: { vault: "0x0", id: 1n } };
    const ix = requestInstantRedeemIx({ holder, payer: holder, sponsored: false, h: evm, sell: 5n, nonce: 1n, book: [bookPda(source)] });
    expect(ix.keys).toHaveLength(spec("request_instant_redeem").accounts.length + 1);
  });

  it("cancel and expire name the payer as owner_wallet and the sponsor only for a sponsored order", async () => {
    const plain = decodeOrder(key(), await orderAccount());
    const sponsored = decodeOrder(key(), await orderAccount({ sponsored_lamports: new BN(3_000_000), payer: key() }));
    for (const make of [cancelInstantRedeemIx, expireInstantRedeemIx]) {
      const a = make(holder, plain);
      expect(a.keys).toHaveLength(spec("cancel_instant_redeem").accounts.length + 1);
      expect(a.keys[5].pubkey.equals(plain.payer)).toBe(true);
      expect(a.keys[6].pubkey.equals(a.programId)).toBe(true);
      expect(make(holder, sponsored).keys[6].pubkey.equals(a.programId)).toBe(false);
    }
  });

  it("fill: creates the seller's token account, then fills with payout accounts, the Treasury vault and the book", async () => {
    const order = decodeOrder(key(), await orderAccount());
    const [ata, fill] = fillInstantRedeemIxs({ filler: key(), order, position: line.position, stakeMint: null, gemas: 100n, book: [bookPda(source)] });
    expect(ata.programId.toBase58()).not.toBe(fill.programId.toBase58());
    // native paying (9) + the Treasury vault (1) + book (1)
    expect(fill.keys).toHaveLength(spec("fill_instant_redeem").accounts.length + 9 + 1 + 1);
    expect(fill.keys[0].isSigner).toBe(true);
    expect(fill.keys[7].pubkey.equals(order.address)).toBe(true);
  });
});

describe("store fixtures stay decodable", () => {
  it("a basket with a won line still encodes", () => {
    expect(encodeStore([lineOf({ source, amount: 5n, side: 1 })]).length).toBeGreaterThan(136);
  });
});
