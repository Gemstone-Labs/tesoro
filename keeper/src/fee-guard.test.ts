import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Keypair } from "@solana/web3.js";
import { feeChangeRefusal, withTimeout } from "./fee-guard.ts";
import type { Head, Stage } from "./safety-sweep.ts";

const head = (stage: Stage, car = false): Head => ({
  address: Keypair.generate().publicKey,
  game: Keypair.generate().publicKey,
  stage,
  joined: true,
  backed: false,
  openedAt: 0,
  deadline: 0,
  ...(car ? { car: { seated: 5, minSeats: 5, firstMinAt: 0, departedAt: 0, refundAfter: 0 } } : {}),
});

describe("a fee change waits until no Match is open (Q40 review #4: fees are read at settlement)", () => {
  it("is allowed when every Match and car is closed or paid, or there are none", () => {
    assert.equal(feeChangeRefusal([]), null);
    assert.equal(feeChangeRefusal([], []), null);
    assert.equal(feeChangeRefusal([head("closed"), head("closed", true)]), null);
  });

  it("is refused while any head-to-head Match or Railcar car is open, boarding, riding or settling, naming how many and one of them", () => {
    for (const stage of ["open", "active", "settling", "refunding"] as const) {
      for (const car of [false, true]) {
        const h = head(stage, car);
        const why = feeChangeRefusal([head("closed"), h]);
        assert.ok(why, `${stage} ${car ? "car" : "Match"} must refuse`);
        assert.match(why!, /1 open/);
        assert.ok(why!.includes(h.address.toBase58()));
      }
    }
    assert.match(feeChangeRefusal([head("open"), head("active", true), head("settling")])!, /3 open \(2 Matches, 1 car\)/);
  });

  it("is refused when a Match or car row cannot be read (short, an unknown stage, an older layout): it may be open", () => {
    const odd = Keypair.generate().publicKey;
    const why = feeChangeRefusal([head("closed")], [odd]);
    assert.ok(why);
    assert.match(why!, /1 Match or car could not be read/);
    assert.ok(why!.includes(odd.toBase58()));
  });
});

describe("listing the open Matches gives up with a clear message instead of hanging", () => {
  it("rejects after the timeout, naming what to do", async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 20, "listing the Matches"), /listing the Matches took longer than 0\.02 s.*--rpc/);
  });

  it("passes a result that comes in time", async () => {
    assert.equal(await withTimeout(Promise.resolve(7), 1_000, "x"), 7);
  });
});
