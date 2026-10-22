import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { addresses } from "./chain";
import { spectatorPieces, readPublicBattle } from "./spectate";
import { chainState, freshGame } from "./fixture";
import golden from "./fixtures/golden.json";
import { STATUS, battleFromEndState, decodeBattle } from "./decode";

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

  it("never reads an Army account: the only account read is the table's Battle", async () => {
    const id = new PublicKey("SysvarRent111111111111111111111111111111111");
    const ref = { generation: 0, index: 1 };
    const read: string[] = [];
    const conn = {
      getAccountInfo: async (k: PublicKey) => {
        read.push(k.toBase58());
        return null;
      },
    };
    await readPublicBattle(conn as never, ref, id);
    const a = addresses(ref);
    expect(read).toEqual([a.battle.toBase58()]);
    expect(read).not.toContain(a.army0.toBase58());
    expect(read).not.toContain(a.army1.toBase58());
  });

  it("decodes a Battle owned by the delegation program or the game", async () => {
    const bytes = Buffer.from(golden.battle.bytes, "hex");
    const conn = { getAccountInfo: async () => ({ data: bytes, owner: new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"), lamports: 1, executable: false }) };
    const decoded = decodeBattle(bytes);
    const b = await readPublicBattle(conn as never, { generation: 0, index: 0 }, decoded.tesoroMatch);
    expect(b?.eventSeq).toBe(decoded.eventSeq);
  });

  it("shows nothing of a table whose Battle belongs to another Match (the Battle is reused by every Match on its table)", async () => {
    const bytes = Buffer.from(golden.battle.bytes, "hex");
    const conn = { getAccountInfo: async () => ({ data: bytes, owner: new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh"), lamports: 1, executable: false }) };
    expect(await readPublicBattle(conn as never, { generation: 0, index: 0 }, new PublicKey("SysvarRent111111111111111111111111111111111"))).toBeNull();
  });

  it("shows the board kept in the Match history once the table has moved on", () => {
    const sq = Array(60).fill(255);
    const shown = Array(60).fill(0);
    sq[3] = 14;
    shown[3] = 7;
    sq[40] = 74;
    const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
    const b = battleFromEndState(
      { game: "vanguard", usSeat: 1, winner: 0, reason: 0, moves: 9, turnNo: 12, sq, shown, endMask: "8", depotClaimed: [0, 1], players: [key(1).toBase58(), key(2).toBase58()] },
      key(3),
    );
    expect([b.status, b.usSeat, b.winner, b.moves, b.endMask]).toEqual([STATUS.over, 1, 0, 9, 8n]);
    expect(b.tesoroMatch.equals(key(3))).toBe(true);
    const ps = spectatorPieces(b);
    expect(ps).toHaveLength(2);
    expect(ps.find((p) => p.id === 3)).toMatchObject({ up: true, rank: "7" });
    expect(ps.find((p) => p.id === 40)).toMatchObject({ up: false, rank: null });
  });
});
