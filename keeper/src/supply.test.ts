import assert from "node:assert/strict";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { accountBytes, bookBytes } from "./fixtures.ts";
import { bookOf, ckptOf, pda } from "./kit.ts";
import { loadIdl } from "./runtime.ts";
import { SIM_SOL_MINT, bookCheckpointCounts, pageCandidates, supplySources, type Info, type Reader } from "./supply.ts";

const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
const k = () => Keypair.generate().publicKey;
const info = (data: Buffer): Info => ({ data, executable: false, lamports: 1, owner: PublicKey.default });
const reader = (accounts: Map<string, Buffer>): Reader => ({ async many(keys) { return keys.map((x) => (accounts.has(x.toBase58()) ? info(accounts.get(x.toBase58())!) : null)); } });
const keysOf = (metas: { pubkey: PublicKey }[]) => new Set(metas.map((m) => m.pubkey.toBase58()));

describe("Source book facts", () => {
  it("reads the closed-segment count of every class, extensions included", () => {
    assert.deepEqual(bookCheckpointCounts(bookBytes([0, 5, 0, 33])), [0, 5, 0, 33]);
    assert.deepEqual(bookCheckpointCounts(bookBytes([0, 0, 0, 0, 7, 8])), [0, 0, 0, 0, 7, 8]);
  });
  it("asks for the page being filled and its neighbours, never for Platform or Leaderboard", () => {
    const c = pageCandidates([9, 31, 9, 32, 0]);
    assert.deepEqual(c.map((x) => `${x.cls}:${x.page}`), ["1:0", "1:1", "3:0", "3:1", "3:2", "4:0", "4:1"]);
  });
});

describe("supplying the Sources of a chunk", () => {
  const source = k();
  const owner = k();

  async function world(over: { chain?: object; asset?: PublicKey; stakeRate?: number } = {}) {
    const position = k();
    const accounts = new Map<string, Buffer>();
    accounts.set(bookOf(source).toBase58(), bookBytes([0, 40, 0, 3]));
    accounts.set(ckptOf(source, 1, 1).toBase58(), Buffer.alloc(10));
    accounts.set(ckptOf(source, 3, 0).toBase58(), Buffer.alloc(10));
    accounts.set(source.toBase58(), await accountBytes(core, "SourceState", { inner: { position: position.toBytes(), owner: owner.toBytes() } }));
    accounts.set(
      position.toBase58(),
      await accountBytes(core, "PositionState", { inner: { owner: owner.toBytes(), sourceChain: over.chain ?? { solana: {} }, sourceAsset: (over.asset ?? SIM_SOL_MINT).toBytes(), stakeRateOpen: new anchor.BN(over.stakeRate ?? 0) } }),
    );
    return { accounts, position };
  }

  it("a Back or Surplus step needs only the book and the pages that exist", async () => {
    const { accounts } = await world();
    const s = await supplySources(core, reader(accounts), [{ source, cut: false }]);
    assert.deepEqual(keysOf(s.metas), new Set([bookOf(source), ckptOf(source, 1, 1), ckptOf(source, 3, 0)].map((x) => x.toBase58())));
    assert.ok(s.metas.every((m) => m.isWritable));
  });

  it("a fee cut also needs the Source, its Position and the native custody with its pool (read only)", async () => {
    const { accounts, position } = await world();
    const pool = k();
    accounts.set(pda("native").toBase58(), await accountBytes(core, "NativeCustody", { pool }));
    const s = await supplySources(core, reader(accounts), [{ source, cut: true }]);
    const keys = keysOf(s.metas);
    for (const x of [source, position, pda("native"), pool]) assert.ok(keys.has(x.toBase58()), x.toBase58());
    const ro = s.metas.filter((m) => !m.isWritable).map((m) => m.pubkey.toBase58());
    assert.deepEqual(new Set(ro), new Set([pda("native").toBase58(), pool.toBase58()]));
  });

  it("a staking token Position needs its stake custody and stake pool", async () => {
    const mint = k();
    const { accounts } = await world({ asset: mint, stakeRate: 5 });
    const pool = k();
    accounts.set(pda("stake_custody", mint.toBuffer()).toBase58(), await accountBytes(core, "StakeCustody", { pool, mint }));
    const keys = keysOf((await supplySources(core, reader(accounts), [{ source, cut: true }])).metas);
    assert.ok(keys.has(pda("stake_custody", mint.toBuffer()).toBase58()) && keys.has(pool.toBase58()));
  });

  it("a bridged Position needs no custody, and a Source without a book is reported", async () => {
    const { accounts, position } = await world({ chain: { ethereum: {} } });
    const s = await supplySources(core, reader(accounts), [{ source, cut: true }]);
    assert.ok(keysOf(s.metas).has(position.toBase58()) && !keysOf(s.metas).has(pda("native").toBase58()));
    const gone = k();
    const none = await supplySources(core, reader(accounts), [{ source: gone, cut: true }]);
    assert.deepEqual(none.missing.map((m) => m.toBase58()), [gone.toBase58()]);
    assert.equal(none.metas.length, 0);
  });
});
