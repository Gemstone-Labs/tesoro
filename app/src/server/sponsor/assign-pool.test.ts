import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import type { GameId } from "@/lib/mock/types";
import { Assigner, MemoryLeaseStore, MemoryTablePool } from "./assign";

const k = () => Keypair.generate().publicKey;
const GAMES: GameId[] = ["block-puzzle", "holdem", "trading-duel", "vanguard"];

function rig(tables: number, epoch = 4n) {
  let now = 1_000_000;
  const pool = new MemoryTablePool(() => now);
  for (const g of GAMES) pool.publish(g, Array.from({ length: tables }, (_, i) => ({ generation: 1, index: i, epoch })));
  const assigner = new Assigner({ operator: Keypair.generate(), leases: new MemoryLeaseStore(), tables: (g) => pool.tables(g), claim: (g, pick, key) => pool.claim(g, pick, key), now: () => now });
  /** One join: build the assignment, then send it. */
  const join = async (game: GameId, n: number) => {
    const a = await assigner.assign(game, k(), k(), k(), `h${n}`, `opener-${game}-${n}`);
    if (a) await assigner.confirm(a);
    return a;
  };
  return { pool, assigner, join, advance: (ms: number) => (now += ms) };
}

describe("the table pool kept by the server", () => {
  it("ten joins in a row each get a table, in all four Games, with no keeper pass", async () => {
    const { join } = rig(10);
    for (const game of GAMES) {
      const keys = new Set<string>();
      for (let n = 0; n < 10; n++) keys.add((await join(game, n))!.leaseKey);
      expect(keys.size).toBe(10);
      expect(await join(game, 10)).toBeNull();
    }
  });

  it("holds a table for its Match well past the lease, and gives it back one epoch on when the Match settles", async () => {
    const { join, pool, advance } = rig(1);
    const first = (await join("holdem", 1))!;
    advance(3_600_000);
    expect(await join("holdem", 2)).toBeNull();
    await pool.free("opener-holdem-1", true);
    const again = (await join("holdem", 3))!;
    expect(first.leaseKey).toBe("holdem/1/0/4");
    expect(again.leaseKey).toBe("holdem/1/0/5");
  });

  it("a join that is never sent holds no table once its build lease expires", async () => {
    const { assigner, advance } = rig(1);
    await assigner.assign("holdem", k(), k(), k(), "p1", "m1");
    advance(91_000);
    expect(await assigner.assign("holdem", k(), k(), k(), "p2", "m2")).not.toBeNull();
  });

  it("a table of unknown epoch is not offered until the rollup is read", async () => {
    const { join, pool } = rig(1);
    await join("holdem", 1);
    await pool.free("opener-holdem-1", false);
    expect(await join("holdem", 2)).toBeNull();
    pool.publish("holdem", [{ generation: 1, index: 0, epoch: 9n }]);
    expect((await join("holdem", 3))?.leaseKey).toBe("holdem/1/0/9");
  });

  it("repairs drift: a table claimed long ago that the rollup shows free is offered again", async () => {
    const { join, pool, advance } = rig(1);
    await join("holdem", 1);
    advance(10 * 60_000);
    pool.publish("holdem", [{ generation: 1, index: 0, epoch: 4n }]);
    expect(await join("holdem", 2)).not.toBeNull();
  });
});
