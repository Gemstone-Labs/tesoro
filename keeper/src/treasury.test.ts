import assert from "node:assert/strict";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { Budget, type Ctx } from "./act.ts";
import { accountBytes, chainOf, storeBytes } from "./fixtures.ts";
import { basketOf, pda } from "./kit.ts";
import { bookOf } from "./kit.ts";
import { bookBytes } from "./fixtures.ts";
import { loadIdl } from "./runtime.ts";
import { SIM_SOL_MINT, type Info } from "./supply.ts";
import { BRIDGE } from "./lz.ts";
import { largestRedeemable, planTreasuryRedeems, treasuryJob, type TreasuryDeps } from "./treasury.ts";

const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
const k = () => Keypair.generate().publicKey;
const line = (amount: bigint, over: object = {}) => ({ side: 0, cls: 3, tranche: 0, dueAt: 0n, source: k(), amount, ...over });

describe("planning Treasury redeems", () => {
  it("takes playable lines of at least the minimum, the largest first, at most the cap", () => {
    const lines = [line(50n), line(900n), line(300n), line(700n), line(5000n, { cls: 0 }), line(400n, { cls: 4, tranche: 1 })];
    assert.deepEqual(planTreasuryRedeems(lines, 3, 100n).map((l) => l.amount), [900n, 700n, 400n]);
    assert.deepEqual(planTreasuryRedeems(lines, 9, 100n).map((l) => l.amount), [900n, 700n, 400n, 300n]);
    assert.deepEqual(planTreasuryRedeems([], 4), []);
  });
});

describe("how much of a line is repaid", () => {
  const repaidUpTo = (n: bigint) => async (k: bigint) => k <= n;
  it("finds the largest amount a dry run accepts", async () => {
    for (const repaid of [100n, 101n, 1234n, 4000n]) assert.equal(await largestRedeemable(100n, 4096n, repaidUpTo(repaid)), repaid);
    // with a wide range the search is bounded and answers a safe lower bound
    const wide = (await largestRedeemable(100n, 1_000_000n, repaidUpTo(777_777n)))!;
    assert.ok(wide <= 777_777n && 777_777n - wide < 300n, `wide ${wide}`);
  });
  it("is the whole line when all of it is repaid, and null when not even the minimum is", async () => {
    assert.equal(await largestRedeemable(100n, 5000n, repaidUpTo(9999n)), 5000n);
    assert.equal(await largestRedeemable(100n, 5000n, repaidUpTo(99n)), null);
  });
  it("uses a bounded number of dry runs", async () => {
    let calls = 0;
    await largestRedeemable(1n, 1n << 40n, async (k) => (calls++, k <= 123_456_789n));
    assert.ok(calls <= 14, `calls ${calls}`);
  });
});

describe("the Treasury job", () => {
  const payer = Keypair.generate();

  async function world(chain: object, amount = 1000n) {
    const [source, position, vault, treasuryAccount] = [k(), k(), k(), k()];
    const accounts = new Map<string, Buffer>();
    accounts.set(pda("treasury").toBase58(), await accountBytes(core, "Treasury", { account: treasuryAccount, vault }));
    accounts.set(basketOf(treasuryAccount).toBase58(), storeBytes([{ source, amount, cls: 3 }], { account: treasuryAccount, capacity: 4 }));
    accounts.set(source.toBase58(), await accountBytes(core, "SourceState", { inner: { position: position.toBytes() } }));
    accounts.set(bookOf(source).toBase58(), bookBytes([0, 0, 0, 0]));
    accounts.set(position.toBase58(), await accountBytes(core, "PositionState", { inner: { sourceChain: chain, sourceAsset: SIM_SOL_MINT.toBytes() } }));
    accounts.set(pda("native").toBase58(), await accountBytes(core, "NativeCustody", { pool: k(), vault: k(), mint: SIM_SOL_MINT }));
    return { accounts, source };
  }

  function run(accounts: Map<string, Buffer>, repaid: bigint, now = 0) {
    const sent: { ix: TransactionInstruction }[] = [];
    const d: TreasuryDeps = {
      read: { async many(keys) { return keys.map((x) => (accounts.has(x.toBase58()) ? ({ data: accounts.get(x.toBase58())! } as Info) : null)); } },
      send: async (ixs) => (sent.push({ ix: ixs[0] }), "sig"),
      simulate: async (ixs) => {
        const decoded: any = ixs[0].programId.equals(BRIDGE) ? { amount: BigInt(Buffer.from(ixs[0].data).readBigUInt64LE(8 + 1 + 8 + 2)) } : (core.coder.instruction as any).decode(Buffer.from(ixs[0].data));
        const amount = decoded.amount !== undefined ? BigInt(decoded.amount.toString()) : BigInt(decoded.data.amount.toString());
        return amount <= repaid ? null : "NotRepaid";
      },
      now: () => now,
    };
    const ctx = { core: chainOf(core, accounts), conn: { getBalance: async () => 1e9 }, payer, now: 0, settings: { dryRun: false }, budget: new Budget(1e15), lz: new Budget(1e15) } as unknown as Ctx;
    return { d, ctx, sent };
  }

  it("redeems the repaid part of a Solana line with the Treasury's vault as payee", async () => {
    const w = await world({ solana: {} });
    const r = run(w.accounts, 640n);
    assert.equal(await treasuryJob(r.ctx, r.d), 1);
    const ix: any = (core.coder.instruction as any).decode(Buffer.from(r.sent[0].ix.data));
    assert.equal(ix.name, "redeemTreasury");
    assert.equal(ix.data.amount.toString(), "640");
  });

  it("goes through the bridge for an ETH or HYPE line", async () => {
    const w = await world({ ethereum: {} });
    const r = run(w.accounts, 1000n, 1);
    assert.equal(await treasuryJob(r.ctx, r.d), 1);
    assert.ok(r.sent[0].ix.programId.equals(BRIDGE));
  });

  it("waits when fewer Gemas than the minimum are repaid, and does not try the same line again at once", async () => {
    const w = await world({ solana: {} }, 5000n);
    let sims = 0;
    const r = run(w.accounts, 10n);
    const inner = r.d.simulate;
    r.d.simulate = async (ixs) => (sims++, inner(ixs));
    r.d.now = () => 5_000_000;
    assert.equal(await treasuryJob(r.ctx, r.d), 0);
    const first = sims;
    assert.equal(await treasuryJob(r.ctx, r.d), 0);
    assert.equal(sims, first, "no new dry runs for a line in its cool-down");
    assert.deepEqual(r.sent, []);
  });
});
