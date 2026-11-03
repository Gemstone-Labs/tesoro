import { Keypair, PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { Assigner, MemoryLeaseStore, joinOf, type LeaseStore } from "./assign";
import { joinMatchIx } from "./fixtures";
import { GAME_IDS } from "@/lib/chain/games";
import { assignMatchIx } from "./assign-ix";

const k = () => Keypair.generate().publicKey;
const T = (index: number, epoch = 1n) => ({ generation: 1, index, epoch });

function rig(tables: ReturnType<typeof T>[], leases: LeaseStore = new MemoryLeaseStore()) {
  let now = 1_000_000;
  const operator = Keypair.generate();
  const assigner = new Assigner({ operator, leases, tables: async () => tables, now: () => now });
  return { assigner, operator, leases, advance: (ms: number) => (now += ms) };
}

describe("Assigner", () => {
  it("assigns the lowest free table and builds the instruction for it", async () => {
    const { assigner, operator } = rig([T(2), T(0), T(1)]);
    const [match, a, b] = [k(), k(), k()];
    const got = await assigner.assign("holdem", match, a, b, "p1");
    expect(got?.ix.data.toString("hex")).toBe(assignMatchIx("holdem", { operator: operator.publicKey, match, accountA: a, accountB: b, pick: { generation: 1, index: 0, epoch: 1n } }).data.toString("hex"));
  });

  it("two simultaneous joins get different tables", async () => {
    const { assigner } = rig([T(0), T(1)]);
    const [x, y] = await Promise.all([assigner.assign("holdem", k(), k(), k(), "p1"), assigner.assign("holdem", k(), k(), k(), "p2")]);
    expect(x && y).toBeTruthy();
    expect(x!.leaseKey).not.toBe(y!.leaseKey);
  });

  it("gives null (the keeper assigns later) when every table is leased", async () => {
    const { assigner } = rig([T(0)]);
    expect(await assigner.assign("holdem", k(), k(), k(), "p1")).not.toBeNull();
    expect(await assigner.assign("holdem", k(), k(), k(), "p2")).toBeNull();
  });

  it("reuses a table once its lease expired", async () => {
    const { assigner, advance } = rig([T(0)]);
    const first = await assigner.assign("holdem", k(), k(), k(), "p1");
    advance(91_000);
    const second = await assigner.assign("holdem", k(), k(), k(), "p2");
    expect(second?.leaseKey).toBe(first?.leaseKey);
  });

  it("keeps the table through the start window once the join was sent, and frees it when released", async () => {
    const { assigner, advance } = rig([T(0)]);
    const first = (await assigner.assign("holdem", k(), k(), k(), "p1"))!;
    await assigner.confirm(first);
    advance(200_000);
    expect(await assigner.assign("holdem", k(), k(), k(), "p2")).toBeNull();
    await assigner.release(first);
    expect(await assigner.assign("holdem", k(), k(), k(), "p3")).not.toBeNull();
  });

  it("a new epoch of the same table is a new lease", async () => {
    const leases = new MemoryLeaseStore();
    const a = rig([T(0, 1n)], leases);
    await a.assigner.assign("holdem", k(), k(), k(), "p1");
    const b = rig([T(0, 2n)], leases);
    expect(await b.assigner.assign("holdem", k(), k(), k(), "p2")).not.toBeNull();
  });

});

describe("joinOf", () => {
  it("reads the Match, the Game and the joining Account out of a join_match", async () => {
    const relayer = k();
    const player = k();
    const game = GAME_IDS.holdem;
    const ix = await joinMatchIx(relayer, player, game);
    const j = joinOf([ix]);
    expect(j?.game).toBe("holdem");
    expect(j?.match.toBase58()).toBe(ix.keys[8].pubkey.toBase58());
    expect(j?.joiner.toBase58()).toBe(ix.keys[2].pubkey.toBase58());
  });

  it("is null without a join_match, and for a program that is not a Game", async () => {
    expect(joinOf([])).toBeNull();
    expect(joinOf([await joinMatchIx(k(), k(), new PublicKey("11111111111111111111111111111111"))])).toBeNull();
  });
});
