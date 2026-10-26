import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import coreIdl from "../../app/src/lib/chain/idl/tesoro_core.json" with { type: "json" };
import { BATCH, KINDS, RETIRE_REQUESTS_BEFORE, SPACE, ataOf, batches, buildIx, coreProgram, planAll, type Row, type Snapshot } from "./retire-old.ts";

const disc = (name: string) =>
  name === "HoldingState"
    ? Buffer.from("593253109b4c98fe", "hex") // the type left the program, so the IDL does not list it
    : Buffer.from((coreIdl as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((a) => a.name === name)!.discriminator);
const key = () => Keypair.generate().publicKey;
const NOW = 1_792_400_000; // 2026-10-19, before RETIRE_REQUESTS_BEFORE

function row(name: string, len: number, fill: (d: Buffer) => void = () => {}): Row {
  const data = Buffer.alloc(len);
  disc(name).copy(data);
  fill(data);
  return { pubkey: key(), data, lamports: 1 };
}
const put = (d: Buffer, at: number, k: PublicKey) => k.toBuffer().copy(d, at);

class World {
  rows = new Map<string, Row>();
  vaults = new Map<string, bigint>();
  atas = new Set<string>();
  add(r: Row) {
    this.rows.set(r.pubkey.toBase58(), r);
    return r;
  }
  oldCustody(owner = key(), shares = 7n, hasAta = true) {
    const vault = key();
    const r = this.add(row("NativeCustody", 210, (d) => (put(d, 10, key()), put(d, 42, owner), put(d, 138, vault))));
    this.vaults.set(vault.toBase58(), shares);
    if (hasAta) this.atas.add(ataOf(owner).toBase58());
    return { custody: r, vault, owner };
  }
  position(len: number) {
    return this.add(row("PositionState", len));
  }
  source(position: PublicKey) {
    return this.add(row("SourceState", 142, (d) => put(d, 9, position)));
  }
  holding(source: PublicKey, amount = 10n) {
    return this.add(row("HoldingState", 90, (d) => (put(d, 9, key()), put(d, 41, source), d.writeBigUInt64LE(amount, 74))));
  }
  offer(sources: PublicKey[]) {
    return this.add(
      row("OfferState", SPACE.offer + 4 + 41 * sources.length, (d) => {
        // kind Public (1 byte), status, expires, use_by, player None, request None, applicants 0, then lines
        let off = 8 + 1 + 8 + 32 + 32 + 8 + 2;
        d[off++] = 1;
        off += 1 + 8 + 8;
        off += 1 + 1;
        d.writeUInt32LE(0, off);
        off += 4;
        d.writeUInt32LE(sources.length, off);
        off += 4;
        sources.forEach((s, i) => put(d, off + i * 41, s));
      }),
    );
  }
  snapshot(): Snapshot {
    return { rows: this.rows, vaults: this.vaults, atas: this.atas, now: NOW };
  }
}

describe("retire plan", () => {
  it("keeps SPACE.offer equal to the program's OfferState::SPACE (174 B)", () => {
    assert.equal(SPACE.offer, 174);
  });

  it("never plans a current-size Position, custody, Treasury or Offer", () => {
    const w = new World();
    w.position(SPACE.position);
    w.add(row("NativeCustody", SPACE.custody));
    w.add(row("Treasury", SPACE.treasury));
    w.add(row("OfferState", SPACE.offer));
    const plan = planAll(w.snapshot());
    assert.equal(plan.phases.flat().length, 0);
  });

  it("orders Positions, then Sources, then Holdings, then Offers, and leaves current ones alone", () => {
    const w = new World();
    const oldPos = w.position(159);
    const curPos = w.position(SPACE.position);
    const goneParent = key();
    const s1 = w.source(oldPos.pubkey);
    const s2 = w.source(goneParent);
    const live = w.source(curPos.pubkey);
    const h1 = w.holding(s1.pubkey, 40n);
    const h2 = w.holding(s2.pubkey, 2n);
    const hLive = w.holding(live.pubkey);
    const oOld = w.offer([s1.pubkey, s2.pubkey]);
    const oLive = w.offer([s1.pubkey, live.pubkey]);
    w.add(row("Treasury", 103));
    const plan = planAll(w.snapshot());
    const kinds = plan.phases.map((p) => [...new Set(p.map((i) => i.kind))].sort());
    assert.deepEqual(kinds, [["position", "treasury"], ["source"], ["holding"], ["offer"]]);
    assert.deepEqual(plan.phases[1].map((i) => i.key.toBase58()).sort(), [s1.pubkey, s2.pubkey].map((k) => k.toBase58()).sort());
    assert.deepEqual(plan.phases[2].map((i) => i.key.toBase58()).sort(), [h1.pubkey, h2.pubkey].map((k) => k.toBase58()).sort());
    assert.equal(plan.phases[2].reduce((a, i) => a + (i.amount ?? 0n), 0n), 42n);
    assert.deepEqual(plan.phases[3].map((i) => i.key.toBase58()), [oOld.pubkey.toBase58()]);
    const skipped = plan.skipped.map((s) => s.key).sort();
    assert.deepEqual(skipped, [live.pubkey, hLive.pubkey, oLive.pubkey].map((k) => k.toBase58()).sort());
  });

  it("returns custody simSOL to the owner, noting a missing simSOL account", () => {
    const w = new World();
    const a = w.oldCustody(key(), 5n, true);
    const b = w.oldCustody(key(), 3n, false);
    const items = planAll(w.snapshot()).phases[0];
    assert.equal(items.length, 2);
    const ia = items.find((i) => i.key.equals(a.custody.pubkey))!;
    const ib = items.find((i) => i.key.equals(b.custody.pubkey))!;
    assert.equal(ia.amount, 5n);
    assert.equal(ia.createsAta, false);
    assert.equal(ib.createsAta, true);
    assert.ok(ib.refs.ownerToken.equals(ataOf(b.owner)));
  });

  it("skips a custody whose vault is missing, and Requests still inside their life", () => {
    const w = new World();
    const c = w.oldCustody();
    w.vaults.clear();
    w.add(row("RequestState", 98, (d) => d.writeBigInt64LE(BigInt(NOW), 8 + 1 + 8 + 32 + 32 + 8)));
    w.add(row("RequestState", 98, (d) => d.writeBigInt64LE(BigInt(NOW - 2 * 86_400), 8 + 1 + 8 + 32 + 32 + 8)));
    w.add(row("RequestState", 98, (d) => d.writeBigInt64LE(BigInt(RETIRE_REQUESTS_BEFORE), 8 + 1 + 8 + 32 + 32 + 8)));
    const plan = planAll({ ...w.snapshot(), now: RETIRE_REQUESTS_BEFORE + 10 * 86_400 });
    assert.deepEqual(plan.phases.flat().map((i) => i.kind), ["request", "request"]);
    assert.equal(plan.skipped.length, 2);
    assert.ok(plan.skipped.some((s) => s.reason.includes("after the reset")));
    assert.ok(plan.skipped.some((s) => s.key === c.custody.pubkey.toBase58()));
  });

  it("plans legacy Matches and Seasons by exact length only, and Sources and Holdings by exact historical layout", () => {
    const w = new World();
    const m435 = w.add(row("MatchState", 435));
    const m915 = w.add(row("MatchState", 915));
    w.add(row("MatchState", 776));
    const season = w.add(row("SeasonState", 504));
    w.add(row("SeasonState", 1387));
    const currentSource = w.add(row("SourceState", 170, (d) => put(d, 9, key())));
    const odd = w.add(row("HoldingState", 91, (d) => put(d, 41, key())));
    const plan = planAll(w.snapshot());
    const planned = plan.phases.flat().map((i) => `${i.kind}:${i.key.toBase58()}`).sort();
    assert.deepEqual(planned, [m435, m915].map((r) => `match:${r.pubkey.toBase58()}`).concat(`season:${season.pubkey.toBase58()}`).sort());
    const skipped = plan.skipped.map((x) => x.key);
    assert.ok(skipped.includes(currentSource.pubkey.toBase58()) && skipped.includes(odd.pubkey.toBase58()));
  });

  it("retires what a legacy Source counted, whatever the amount", () => {
    const w = new World();
    const s = w.source(key());
    w.holding(s.pubkey, 2n ** 60n);
    const plan = planAll(w.snapshot());
    assert.deepEqual(plan.phases.map((p) => p.length), [0, 1, 1, 0]);
  });

  it("is idempotent: once the accounts are gone nothing is planned", () => {
    const w = new World();
    const p = w.position(159);
    const s = w.source(p.pubkey);
    w.holding(s.pubkey);
    for (const phase of planAll(w.snapshot()).phases) for (const i of phase) w.rows.delete(i.key.toBase58());
    assert.equal(planAll(w.snapshot()).phases.flat().length, 0);
  });
});

describe("retire transactions", () => {
  it("every kind's largest batch fits one transaction", async () => {
    const w = new World();
    const program = coreProgram();
    const admin = key();
    const items = {
      custody: Array.from({ length: BATCH.custody }, () => planAll((() => { const x = new World(); x.oldCustody(); return x.snapshot(); })()).phases[0][0]),
      position: Array.from({ length: BATCH.position }, () => ({ kind: "position" as const, key: key(), refs: { position: key() } })),
      source: Array.from({ length: BATCH.source }, () => ({ kind: "source" as const, key: key(), refs: { source: key(), position: key() } })),
      holding: Array.from({ length: BATCH.holding }, () => ({ kind: "holding" as const, key: key(), refs: { holding: key(), source: key() } })),
      offer: Array.from({ length: BATCH.offer }, () => ({ kind: "offer" as const, key: key(), refs: { offer: key() }, remaining: Array.from({ length: 8 }, key) })),
      request: Array.from({ length: BATCH.request }, () => ({ kind: "request" as const, key: key(), refs: { request: key() } })),
      treasury: [{ kind: "treasury" as const, key: key(), refs: { treasury: key() } }],
      match: Array.from({ length: BATCH.match }, () => ({ kind: "match" as const, key: key(), refs: { account: key() } })),
      season: Array.from({ length: BATCH.season }, () => ({ kind: "season" as const, key: key(), refs: { account: key() } })),
    };
    void w;
    for (const k of KINDS) {
      const ixs = await Promise.all(items[k].map((i) => buildIx(program, admin, i)));
      const tx = new Transaction({ feePayer: admin, recentBlockhash: key().toBase58() }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs);
      const size = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length + 64;
      assert.ok(size <= 1232, `${k} batch is ${size} bytes`);
    }
    assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });
});
