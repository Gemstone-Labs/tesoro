import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import * as H from "../../app/src/games/holdem/chain.ts";
import * as D from "../../app/src/games/trading-duel/chain.ts";
import * as V from "../../app/src/games/vanguard/chain.ts";
import * as B from "../../app/src/games/block-puzzle/live-chain.ts";
import { holdemFacts, holdemStep } from "./holdem.ts";
import { duelFacts, duelStep } from "./duel.ts";
import { vanguardFacts, vanguardStep } from "./vanguard.ts";
import { burstFacts, burstStep } from "./burst.ts";
import { loadIdl } from "./runtime.ts";

const key = PublicKey.default;
const provider = new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), {} as never, {});
function fixture(program: string, file: string) {
  const bytes = JSON.parse(readFileSync(new URL(`../fixtures/${file}-layouts.json`, import.meta.url), "utf8")) as Record<string, string>;
  const coder = new anchor.Program(loadIdl(program), provider).coder.accounts;
  return (type: string, name: string) => coder.decode(type, Buffer.from(bytes[name], "hex"));
}
const bind = <A,>(a: A, t: { generation: number; index: number; epoch: number }) => ({ ...a, generation: t.generation, index: t.index, epoch: t.epoch, startDeadline: 1300 });

describe("starting an assigned table before begin_match writes its Match key", () => {
  it("Hold'em facts reach begin_match for the real idle-table layout", () => {
    const f = fixture("holdem", "holdem");
    const t = H.decodeTable(key, f("table", "idle_table"));
    const a = bind(H.decodeAssignment(key, f("assignment", "assignment")), t);
    assert.equal(holdemStep(holdemFacts(a, t, null, 1000), 1000, 2000).do, "begin_match");
  });
  it("Trading Duel facts reach begin_match before the table contains a Duel", () => {
    const f = fixture("trading_duel", "trading-duel");
    const t = D.decodeTable(key, f("table", "idle_table"));
    const a = bind(D.decodeAssignment(key, f("assignment", "assignment")), t);
    assert.equal(duelStep(duelFacts(a, t, null, 1000), 1000, 2000).do, "begin_match");
  });
  it("Vanguard facts reach begin_match before a Battle exists", () => {
    const f = fixture("vanguard", "vanguard");
    const t = V.decodeTable(key, f("table", "idle_table"));
    const a = bind(V.decodeAssignment(key, f("assignment", "assignment")), t);
    assert.equal(vanguardStep(vanguardFacts(a, t, null, null, 1000), 1000, 2000, 0n).do, "begin_match");
  });
  it("Block Burst facts reach begin_match before the table contains the Match", () => {
    const f = fixture("block_puzzle", "block-puzzle");
    const t = B.decodeTable(key, f("table", "idle_table"));
    const a = bind(B.decodeAssignment(key, f("assignment", "assignment")), t);
    assert.equal(burstStep(burstFacts(a, t, null, 1000, 0), 1000, 2000).do, "begin_match");
  });
});
