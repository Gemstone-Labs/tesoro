import { BN, BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { bookPda } from "@/lib/chain/basket";
import { encodeBook, encodeLine, freshClass, lineOf } from "@/lib/chain/basket-fixture";
import { fp } from "@/lib/chain/book";
import { decodeOrder } from "@/lib/chain/instant-order";
import { SIM_SOL_MINT } from "@/lib/chain/native";
import { newNonce, signedMessage } from "@/lib/chain/signed-request";
import { DemoHttpError, type AuthEnv } from "../request-auth";
import { buildOrdersReply, handleOrders, type OrdersDeps, type OrdersRaw } from "./orders";

const coder = new BorshAccountsCoder(coreIdl as unknown as Idl);
const key = () => Keypair.generate().publicKey;
const bytes = (k: PublicKey) => Array.from(k.toBytes());
const NOW = 1_800_000_000;
const source = key();
const position = key();
const owner = key();

const srcState = { bump: 1, inner: { position: bytes(position), owner: bytes(key()), index: 0, horizonMonths: 3, unitNum: new BN("10000000000000"), unitDen: new BN(150_000_000), issued: new BN(1000), returned: new BN(0), redeemed: new BN(0), yieldUnits: new BN(0), redeemedUnits: new BN(0) } };
const posState = (over: object = {}) => ({
  bump: 1,
  positionId: Array(32).fill(2),
  inner: { owner: bytes(key()), sourceChain: { solana: {} }, sourceAsset: bytes(SIM_SOL_MINT), decimals: 9, principal: new BN(2_000_000_000), rateBps: 500, status: { locked: {} }, advances: 1, openAdvance: null, lastSeq: new BN(0), cumulativeYield: new BN(0), freeYield: new BN(0), freeYieldClaimed: new BN(0), openedAt: new BN(NOW), appliedNet: new BN(0), custodyShares: new BN(0), yieldFeeBps: 2000, stakeRateOpen: new BN(0), ...over },
});

async function order(amount: bigint, over: Record<string, unknown> = {}) {
  const line = new Uint8Array(144);
  encodeLine(lineOf({ source, amount, side: 1, dueAt: 5n, uncovered: fp(amount) }), line);
  const data = await coder.encode("InstantOrderState", {
    bump: 1, nonce: new BN(1), account: key(), owner, line: Array.from(line), requested: new BN(amount.toString()), created_at: new BN(NOW - 100), expires_at: new BN(NOW + 86_400), sold: new BN(0), redeemed_while_open: new BN(0), paid_shares: new BN(0), payer: owner, sponsored_lamports: new BN(0), ...over,
  });
  return decodeOrder(key(), Buffer.from(data));
}

async function raw(over: Partial<OrdersRaw> & { amount?: bigint; spendable?: bigint } = {}): Promise<OrdersRaw> {
  const o = await order(over.amount ?? 1000n);
  const book = encodeBook([freshClass(), freshClass(), freshClass(), { ...freshClass(), uncovered: fp(1000n), w: fp(1000n) }]);
  const spendable = over.spendable ?? 10n ** 12n;
  return {
    orders: [o],
    sources: new Map([[source.toBase58(), srcState]]),
    positions: new Map([[position.toBase58(), posState()]]),
    books: new Map([[bookPda(source).toBase58(), book]]),
    pool: { baseRate: 1_000_000_000n, baseTs: 0, apyBps: 700, speedup: 4380 },
    stakeRate: null,
    routes: { native: { treasuryShares: spendable, owedShares: 0n, poolOwed: 0n, reserved: 0n, spendable }, stake: null },
    ...over,
  };
}

describe("open orders for the admin", () => {
  it("lists an order with what is left, what is ready and how much of it the route can buy now", async () => {
    const reply = buildOrdersReply(await raw(), NOW);
    expect(reply.orders).toHaveLength(1);
    expect(reply.orders[0]).toMatchObject({ kind: "native", asset: "SOL", state: "requested", remaining: 1000, ready: 0, maxFill: 1000, sponsored: false });
    expect(reply.routes.native?.spendable).toBe(String(10n ** 12n));
  });

  it("caps the fill at the route's spendable shares (a partial fill) and at 0 with no budget", async () => {
    const small = buildOrdersReply(await raw({ spendable: 20_000_000n }), NOW).orders[0];
    expect(small.maxFill).toBeGreaterThan(0);
    expect(small.maxFill).toBeLessThan(1000);
    expect(BigInt(small.maxFillPayoutShares)).toBeLessThanOrEqual(20_000_000n);
    expect(buildOrdersReply(await raw({ spendable: 0n }), NOW).orders[0].maxFill).toBe(0);
  });

  it("counts the yield the clock has landed as ready, which the fill redeems to the seller first", async () => {
    const r = await raw();
    r.positions.set(position.toBase58(), posState({ openAdvance: 0 }));
    const reply = buildOrdersReply(r, NOW + 60);
    expect(reply.orders[0].ready).toBeGreaterThan(0);
    expect(reply.orders[0].maxFill).toBe(1000 - reply.orders[0].ready);
  });

  it("marks an EVM order as the bridge's: no fill from here", async () => {
    const r = await raw();
    r.positions.set(position.toBase58(), posState({ sourceChain: { ethereum: {} } }));
    expect(buildOrdersReply(r, NOW).orders[0]).toMatchObject({ kind: "reported", asset: "ETH", maxFill: 0 });
  });

  it("shows an order past its deadline as expired and drops finished ones", async () => {
    expect(buildOrdersReply(await raw(), NOW + 2 * 86_400).orders[0].state).toBe("expired");
    const r = await raw();
    r.orders = [await order(0n)];
    expect(buildOrdersReply(r, NOW).orders).toEqual([]);
  });
});

describe("orders route auth", () => {
  const dev: AuthEnv = { production: false, devWallet: true, verifyToken: async () => null };
  const admin = Keypair.generate();
  const other = Keypair.generate();
  const deps = (admins: string[]): OrdersDeps => ({ admins, list: async (now) => ({ now, routes: { native: null, stake: null }, orders: [] }) });
  const signed = (kp: Keypair) => {
    const address = kp.publicKey.toBase58();
    const nonce = newNonce();
    const ts = NOW * 1000;
    const sig = nacl.sign.detached(new TextEncoder().encode(signedMessage("tesoro-admin", "orders", address, ts, nonce, {})), kp.secretKey);
    return { step: "orders", address, ts, nonce, signature: Buffer.from(sig).toString("base64") };
  };
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      return e instanceof DemoHttpError ? e.code : String(e);
    }
  };

  it("answers an admin wallet only", async () => {
    const d = deps([admin.publicKey.toBase58()]);
    expect(await code(handleOrders(d, signed(admin), null, dev, NOW * 1000))).toBe("ok");
    expect(await code(handleOrders(d, signed(other), null, dev, NOW * 1000))).toBe("forbidden");
    expect(await code(handleOrders(d, {}, null, dev, NOW * 1000))).toBe("bad-request");
    expect(await code(handleOrders(deps([]), signed(admin), null, dev, NOW * 1000))).toBe("not-configured");
  });

  it("refuses the review step on the orders route", async () => {
    const body = { ...signed(admin), step: "review" };
    expect(await code(handleOrders(deps([admin.publicKey.toBase58()]), body, null, dev, NOW * 1000))).toBe("bad-request");
  });
});
