import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { GAMES, GAME_BATCH, buildGameIx, configOf, gameProgram, legacyLengths, planGame, programOf, type Game, type Row } from "./retire-games.ts";
import blockPuzzleIdl from "../../app/src/lib/chain/idl/block_puzzle.json" with { type: "json" };
import holdemIdl from "../../app/src/lib/chain/idl/holdem.json" with { type: "json" };
import vanguardIdl from "../../app/src/lib/chain/idl/vanguard.json" with { type: "json" };

const IDLS = { block_puzzle: blockPuzzleIdl, holdem: holdemIdl, vanguard: vanguardIdl } as Record<Game, { accounts: { name: string; discriminator: number[] }[] }>;
const TYPE: Record<Game, string> = { block_puzzle: "Board", holdem: "Hole", vanguard: "Army" };
const disc = (g: Game, name = TYPE[g]) => Buffer.from(IDLS[g].accounts.find((a) => a.name === name)!.discriminator);
function row(g: Game, len: number, name = TYPE[g]): Row {
  const data = Buffer.alloc(len);
  disc(g, name).copy(data);
  return { pubkey: Keypair.generate().publicKey, data };
}

describe("game retire plan", () => {
  it("takes the retire-only lengths the programs declare (devnet: Board 605/853, Hole 76/80, Army 144)", () => {
    assert.deepEqual(legacyLengths("block_puzzle"), [605, 853]);
    assert.deepEqual(legacyLengths("holdem"), [76, 80]);
    assert.deepEqual(legacyLengths("vanguard"), [144]);
  });

  for (const g of GAMES) {
    it(`${g}: closes only the exact legacy lengths of the old type, never a current record or another type`, () => {
      const lengths = legacyLengths(g);
      const legacy = lengths.map((l) => row(g, l));
      const current = row(g, 8 + 524); // not a retire-only length
      const wrongLength = row(g, lengths[0] + 1);
      const otherType = row(g, lengths[0], "TableConfig");
      const bare = { pubkey: Keypair.generate().publicKey, data: Buffer.alloc(4) };
      const plan = planGame(g, [...legacy, current, wrongLength, otherType, bare]);
      assert.deepEqual(plan.items.map((i) => i.key.toBase58()).sort(), legacy.map((r) => r.pubkey.toBase58()).sort());
      assert.equal(plan.left, 4);
    });

    it(`${g}: builds retire_legacy_account for the operator, the game's config and the record`, async () => {
      const operator = Keypair.generate().publicKey;
      const item = planGame(g, [row(g, legacyLengths(g)[0])]).items[0];
      const ix = await buildGameIx(gameProgram(g), g, operator, item);
      assert.ok(ix.programId.equals(programOf(g)));
      assert.deepEqual(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable]), [
        [operator.toBase58(), true, true],
        [configOf(g).toBase58(), false, false],
        [item.key.toBase58(), false, true],
      ]);
    });
  }

  it("batches stay under the transaction limits", () => assert.ok(GAME_BATCH <= 10));
});
