import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { BlockBurstChain } from "../../app/src/games/block-puzzle/live-chain.ts";
import { HoldemChain } from "../../app/src/games/holdem/chain.ts";
import { fuelPda as burstFuel } from "../../app/src/games/block-puzzle/live-chain.ts";
import { fuelPda as holdemFuel } from "../../app/src/games/holdem/chain.ts";
import { fuelPda as duelFuel, TradingDuelChain } from "../../app/src/games/trading-duel/chain.ts";
import { fuelPda as vanguardFuel, VanguardChain } from "../../app/src/games/vanguard/chain.ts";
import { loadIdl } from "./runtime.ts";
import { ADAPTERS, createFuelIx, createSponsorIx, setupIx } from "./scheduler-games.ts";

const base = new Connection("http://127.0.0.1:9");
const core = loadIdl("tesoro_core");
const chains: [string, { program: any }, (n: number) => PublicKey][] = [
  ["trading_duel", new TradingDuelChain(loadIdl("trading_duel"), core, { base }), duelFuel],
  ["holdem", new HoldemChain(loadIdl("holdem"), core, { base }), holdemFuel],
  ["block_puzzle", new BlockBurstChain(loadIdl("block_puzzle"), core, { base }), burstFuel],
  ["vanguard", new VanguardChain(loadIdl("vanguard"), core, { base }), vanguardFuel],
];
const operator = Keypair.generate().publicKey;
const validator = Keypair.generate().publicKey;
const ref = { generation: 1, index: 7 };

// Like core-ix.test.ts: every setup instruction is built against the Game's real IDL, so a renamed account fails here.
describe("setup instructions build against each Game's IDL", () => {
  for (const [name, chain, fuelPda] of chains) {
    it(`${name}: create_table, delegate_table, the Sponsor and a Fuel`, async () => {
      const create = await setupIx(chain.program, { do: "create_table", index: 7 }, ref, operator, validator, fuelPda);
      assert.ok(create.programId.equals(chain.program.programId));
      assert.ok(create.keys.some((k) => k.pubkey.equals(operator) && k.isSigner), "the operator signs");
      for (const step of [{ do: "delegate_table", index: 7 }, { do: "delegate_sponsor" }, { do: "delegate_fuel", n: 2 }] as const) {
        const ix = await setupIx(chain.program, step, ref, operator, validator, fuelPda);
        assert.ok(ix.keys.some((k) => k.pubkey.equals(validator)), `${step.do} names the validator`);
        assert.ok(ix.keys.some((k) => k.pubkey.equals(operator) && k.isSigner));
      }
      const sponsor = await createSponsorIx(chain.program, operator, 5_000_000n);
      assert.equal(sponsor.data.readBigUInt64LE(8), 5_000_000n);
      const fuel = await createFuelIx(chain.program, operator, 3, 7_000_000n, fuelPda(3));
      assert.equal(fuel.data[8], 3);
      assert.equal(fuel.data.readBigUInt64LE(9), 7_000_000n);
    });
  }

  it("the table PDA in create_table is the one the adapter looks for", async () => {
    for (const [i, a] of ADAPTERS.entries()) {
      const ix = await setupIx(chains[i][1].program, { do: "create_table", index: 7 }, ref, operator, validator, chains[i][2]);
      assert.ok(ix.keys.some((k) => k.pubkey.equals(a.tableAddress(1, 7))), `${a.label} table address`);
      assert.ok(a.programId.equals(chains[i][1].program.programId), `${a.label} program id`);
    }
  });
});

describe("the four Games", () => {
  it("are registered once each, with distinct labels and env names", () => {
    assert.deepEqual(ADAPTERS.map((a) => a.id), ["trading-duel", "holdem", "block-burst", "vanguard"]);
    assert.equal(new Set(ADAPTERS.map((a) => a.env)).size, 4);
  });
  it("name private seats only where the program has `init_seats`", () => {
    const withSeats = (n: string) => !!loadIdl(n).instructions.find((i: any) => i.name === "init_seats");
    assert.deepEqual(ADAPTERS.map((a) => a.preSeated), ["trading_duel", "holdem", "block_puzzle", "vanguard"].map(withSeats));
  });
  it("the Block Burst id is the program the Match job dispatches on", () => {
    assert.ok(ADAPTERS[2].programId.equals(new PublicKey("5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj")));
  });
});
