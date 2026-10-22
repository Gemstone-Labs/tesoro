import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { addresses } from "./chain";
import { spectatorPieces, readPublicBattle } from "./spectate";
import { chainState, freshGame } from "./fixture";
import golden from "./fixtures/golden.json";
import { decodeBattle } from "./decode";

describe("spectating a Vanguard Match", () => {
  const { battle } = chainState(freshGame(3), freshGame(3), []);

  it("shows every piece face down while no rank is public", () => {
    const ps = spectatorPieces(battle);
    expect(ps).toHaveLength(40);
    expect(ps.every((p) => !p.up && p.rank === null)).toBe(true);
  });

  it("shows only the ranks the Battle published", () => {
    const b = { ...battle, shown: battle.shown.map((s, i) => (i === 3 ? 7 : 0)) };
    const up = spectatorPieces(b).filter((p) => p.up);
    expect(up.map((p) => [p.id, p.rank])).toEqual([[3, "7"]]);
  });

  it("never reads an Army account: the only account read is the Battle", async () => {
    const id = new PublicKey("SysvarRent111111111111111111111111111111111");
    const read: string[] = [];
    const conn = {
      getAccountInfo: async (k: PublicKey) => {
        read.push(k.toBase58());
        return null;
      },
    };
    await readPublicBattle(conn as never, id);
    const a = addresses(id);
    expect(read).toEqual([a.battle.toBase58()]);
    expect(read).not.toContain(a.army0.toBase58());
    expect(read).not.toContain(a.army1.toBase58());
    expect(read).not.toContain(a.secret.toBase58());
  });

  it("decodes a Battle owned by the delegation program or the game", async () => {
    const bytes = Buffer.from(golden.battle.bytes, "hex");
    const conn = { getAccountInfo: async () => ({ data: bytes, owner: new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"), lamports: 1, executable: false }) };
    const b = await readPublicBattle(conn as never, PublicKey.default);
    expect(b?.eventSeq).toBe(decodeBattle(bytes).eventSeq);
  });
});
