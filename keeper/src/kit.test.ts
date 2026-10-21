import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { potBytes, storeBytes, ticketBytes } from "./fixtures.ts";
import { CORE_ID, basketOf, bookOf, configAddress, countersOf, decodeStore, decodeTicketHead, economyAddress, eventAuthority, ckptOf, matchAddress, matchRefOf, POT_AT, receiptAddress, reservationsAddress, seasonAddress, slack, sponsorAddress, spillOf } from "./kit.ts";
import { loadIdl } from "./runtime.ts";

const k = () => Keypair.generate().publicKey;

describe("line stores", () => {
  it("reads a basket: header facts and each line's key and amount", () => {
    const owner = k();
    const [s1, s2] = [k(), k()];
    const bytes = storeBytes([{ source: s1, amount: 40n, dueAt: 7n }, { source: s2, amount: 9n, side: 1, cls: 4, tranche: 1 }], { account: owner, capacity: 5, first: 1, roomReserved: 2 });
    const st = decodeStore(bytes);
    assert.equal(st.account.toBase58(), owner.toBase58());
    assert.deepEqual([st.len, st.first, st.capacity, st.roomReserved], [2, 1, 5, 2]);
    assert.deepEqual([st.lineAt(0).source.toBase58(), st.lineAt(0).amount, st.lineAt(0).dueAt], [s1.toBase58(), 40n, 7n]);
    assert.deepEqual([st.lineAt(1).side, st.lineAt(1).cls, st.lineAt(1).tranche], [1, 4, 1]);
    assert.throws(() => st.lineAt(2));
  });
  it("reads a Pot, whose store starts after the 160 B Ticket head", () => {
    const s = k();
    const st = decodeStore(potBytes([{ source: s, amount: 5n }]), POT_AT);
    assert.deepEqual([st.len, st.lineAt(0).amount], [1, 5n]);
  });
  it("refuses bytes that are not a store", () => {
    assert.throws(() => decodeStore(Buffer.alloc(10)));
    const bad = storeBytes([{ amount: 1n }]);
    bad.writeUInt32LE(99, 8 + 4);
    assert.throws(() => decodeStore(bad));
  });
  it("counts the free room of an Account: both stores, minus what Matches hold", () => {
    const basket = decodeStore(storeBytes([{ amount: 1n }], { capacity: 4 }));
    const spill = decodeStore(storeBytes([], { capacity: 3, roomReserved: 2 }));
    assert.equal(slack(basket, spill), 3 + 3 - 2);
  });
});

describe("Ticket head", () => {
  it("reads kind, state, owner, expiry and the held spill room", () => {
    const account = k();
    const t = decodeTicketHead(ticketBytes({ kind: 1, state: 1, account, nonce: 9n, target: 500n, expiresAt: 1234, spillRoom: 3 }));
    assert.deepEqual([t.kind, t.state, t.nonce, t.target, t.expiresAt, t.spillRoom], ["backing", "cancelling", 9n, 500n, 1234, 3]);
    assert.equal(t.account.toBase58(), account.toBase58());
  });
  it("refuses a head with an unknown state", () => {
    assert.throws(() => decodeTicketHead(ticketBytes({ state: 9, account: k() })));
  });
});

describe("addresses", () => {
  it("a Match lives at ['match', opener, n]", () => {
    const opener = k();
    const ref = matchRefOf({ opener: opener.toBytes(), n: { toString: () => "5" } });
    const n = Buffer.alloc(8);
    n.writeBigUInt64LE(5n);
    assert.equal(matchAddress(ref).toBase58(), PublicKey.findProgramAddressSync([Buffer.from("match"), opener.toBuffer(), n], CORE_ID)[0].toBase58());
  });
});

describe("addresses agree with the IDL's seeds", () => {
  const idl = loadIdl("tesoro_core");
  const seedsOf = (instruction: string, account: string) => {
    const walk = (accs: any[]): any => accs.flatMap((a) => (a.accounts ? walk(a.accounts) : [a]));
    const hit = walk(idl.instructions.find((i: any) => i.name === instruction).accounts).find((a: any) => a.name === account);
    return hit.pda.seeds as { kind: string; value?: number[]; path?: string }[];
  };
  const consts = (seeds: { kind: string; value?: number[] }[]) => seeds.map((s) => Buffer.from(s.value!));
  const addr = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, CORE_ID)[0];

  it("the fixed accounts: config, economy, sponsor, reservations, event authority", () => {
    assert.equal(addr(consts(seedsOf("record_season", "config"))).toBase58(), configAddress.toBase58());
    assert.equal(addr(consts(seedsOf("record_season", "economy"))).toBase58(), economyAddress.toBase58());
    assert.equal(addr(consts(seedsOf("close_match", "sponsor"))).toBase58(), sponsorAddress.toBase58());
    assert.equal(addr(consts(seedsOf("record_season", "reservations"))).toBase58(), reservationsAddress.toBase58());
    assert.equal(addr(consts(seedsOf("match_chunk", "event_authority"))).toBase58(), eventAuthority.toBase58());
  });

  it("the per-Account stores and counters, the receipt and the Match", () => {
    const account = k();
    const owner = (seeds: { kind: string; value?: number[] }[]) => addr(seeds.map((s) => (s.kind === "const" ? Buffer.from(s.value!) : account.toBuffer())));
    assert.equal(owner(seedsOf("grow_store", "basket")).toBase58(), basketOf(account).toBase58());
    assert.equal(owner(seedsOf("grow_store", "spill")).toBase58(), spillOf(account).toBase58());
    assert.equal(owner(seedsOf("expire_offer", "counters")).toBase58(), countersOf(account).toBase58());
    const match = matchAddress({ opener: account, n: 3n });
    const receipt = seedsOf("refund_match", "receipt").map((s) => (s.kind === "const" ? Buffer.from(s.value!) : match.toBuffer()));
    assert.equal(addr(receipt).toBase58(), receiptAddress(match).toBase58());
    const matchSeeds = seedsOf("match_chunk", "match_state");
    assert.deepEqual(matchSeeds.map((s) => s.kind), ["const", "account", "account"], "[match, opener, n]");
    assert.equal(Buffer.from(matchSeeds[0].value!).toString(), "match");
  });

  it("a Source's book, an order, a prize Source, a Season, a pair", () => {
    const source = k();
    assert.deepEqual(seedsOf("init_source_book", "book").map((x) => x.path ?? Buffer.from(x.value!).toString()), ["book", "source"]);
    assert.equal(bookOf(source).toBase58(), addr([Buffer.from("book"), source.toBuffer()]).toBase58());
    // the checkpoint page: programs/tesoro_core/src/storage.rs ckpt_address = ["ckpt", source, [class], page_no LE]
    const page = ckptOf(source, 3, 5);
    assert.equal(page.toBase58(), addr([Buffer.from("ckpt"), source.toBuffer(), Buffer.from([3]), Buffer.from([5, 0, 0, 0])]).toBase58());
    assert.equal(seasonAddress(2).toBase58(), addr([Buffer.from("season"), Buffer.from([2, 0, 0, 0])]).toBase58());
    assert.deepEqual(seedsOf("record_season", "season").map((x) => x.path ?? Buffer.from(x.value!).toString()), ["season", "number"]);
    assert.deepEqual(seedsOf("fund_season_prize_native", "prize_source").map((x) => x.path ?? Buffer.from(x.value!).toString()), ["prize", "custody", "season"]);
    assert.deepEqual(seedsOf("request_instant_redeem", "order").map((x) => x.path ?? Buffer.from(x.value!).toString()), ["instant", "holder_account", "nonce"]);
    assert.deepEqual(seedsOf("close_pair", "pair").map((x) => x.path ?? Buffer.from(x.value!).toString()), ["pair", "opener", "joiner"]);
  });
});
