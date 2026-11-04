import { Keypair, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { GAME_IDS } from "@/lib/chain/games";
import * as burst from "@/games/block-puzzle/live-chain";
import * as holdem from "@/games/holdem/chain";
import * as vanguard from "@/games/vanguard/chain";
import * as duel from "@/games/trading-duel/chain";
import { CORE_ID } from "./rules";
import { assignMatchIx, canAssign } from "./assign-ix";

const k = () => Keypair.generate().publicKey;

describe("assignMatchIx", () => {
  const operator = k();
  const match = k();
  const a = k();
  const b = k();
  const pick = { generation: 3, index: 5, epoch: 9n };

  const cases = [
    ["block-puzzle", burst.configPda(), burst.authorityPda(), burst.assignmentPda(match)],
    ["holdem", holdem.configPda(), holdem.authorityPda(), holdem.assignmentPda(match)],
    ["trading-duel", duel.configPda(), duel.authorityPda(), duel.assignmentPda(match)],
    ["vanguard", vanguard.tablesPda(), vanguard.authorityPda(), vanguard.assignmentPda(match)],
  ] as const;

  it.each(cases)("%s: names the Game's own PDAs, the operator as the only signer", (game, config, authority, assignment) => {
    const ix = assignMatchIx(game, { operator, match, accountA: a, accountB: b, pick });
    expect(ix.programId.toBase58()).toBe(GAME_IDS[game].toBase58());
    expect(ix.keys.map((x) => x.pubkey.toBase58())).toEqual([operator, config, match, a, b, authority, assignment, CORE_ID, SystemProgram.programId].map((x) => x.toBase58()));
    expect(ix.keys.filter((x) => x.isSigner).map((x) => x.pubkey.toBase58())).toEqual([operator.toBase58()]);
  });

  it("encodes generation, index and epoch after the assign_match discriminator", () => {
    const ix = assignMatchIx("holdem", { operator, match, accountA: a, accountB: b, pick });
    expect([...ix.data.subarray(0, 8)]).toEqual([195, 128, 179, 141, 148, 120, 135, 51]);
    expect(ix.data.readUInt16LE(8)).toBe(3);
    expect(ix.data.readUInt16LE(10)).toBe(5);
    expect(ix.data.readBigUInt64LE(12)).toBe(9n);
    expect(ix.data.length).toBe(20);
  });

  it("assigns every Game", () => {
    for (const game of ["block-puzzle", "holdem", "trading-duel", "vanguard"] as const) expect(canAssign(game)).toBe(true);
  });
});
