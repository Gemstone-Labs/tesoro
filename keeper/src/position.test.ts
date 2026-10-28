import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { accountBytes } from "./fixtures.ts";
import { decodeCorePosition, positionQueries } from "./position.ts";
import { loadIdl } from "./runtime.ts";

const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
const fixtures = JSON.parse(readFileSync(new URL("../../app/src/lib/chain/position-size.fixtures.json", import.meta.url), "utf8"));
const devnet = (k: "some" | "noneStale") => Buffer.from(fixtures[k].data, "base64");

describe("the keeper reads a Position of either layout (ticket 55)", () => {
  it("decodes real 235-byte devnet Positions with an open Advance and with stale bytes after a closed one", () => {
    const some = decodeCorePosition(core, devnet("some"));
    assert.notEqual(some.inner.openAdvance, null);
    assert.equal(some.inner.stakeRateHigh.toString(), "0");
    const none = decodeCorePosition(core, devnet("noneStale"));
    assert.equal(none.inner.openAdvance, null);
    assert.equal(none.inner.stakeRateHigh.toString(), "0");
  });

  it("decodes a 243-byte Position with its highest priced rate", async () => {
    const high = new anchor.BN("1320000000000");
    for (const openAdvance of [3, null]) {
      const raw = await accountBytes(core, "PositionState", { inner: { sourceChain: { solana: {} }, openAdvance, stakeRateOpen: new anchor.BN("1200000000000"), stakeRateHigh: high } });
      const data = Buffer.alloc(243, 0xcd);
      raw.copy(data);
      const p = decodeCorePosition(core, data);
      assert.equal(p.inner.stakeRateHigh.toString(), high.toString());
      assert.equal(p.inner.openAdvance, openAdvance);
    }
  });

  it("lists Positions of both sizes", () => {
    assert.deepEqual(positionQueries().map((q) => q.dataSize), [243, 235]);
    assert.ok(new PublicKey(core.programId));
  });
});
