import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AlertManager, type Alert, type Watch } from "./alerts.ts";
import { BALANCE_CHECK_EVERY_MS, balanceCheck, extraWatches, type BalanceState } from "./balance-check.ts";

const H = 3_600_000;
const watch: Watch = { key: "balance:keeper:solana", label: "keeper on Solana", unit: "SOL", min: 0.3, address: "KeepAddr", net: "solana" };

function rig(balance: () => number) {
  const sent: Alert[] = [];
  let saved: BalanceState | null = null;
  let reads = 0;
  const run = (now: number) =>
    balanceCheck({
      now,
      load: () => saved,
      save: (s) => void (saved = s),
      watches: [watch],
      read: async () => (reads++, balance()),
      manager: (st) => new AlertManager(async (a) => (sent.push(a), true), 4 * H).restore(st),
    });
  return { sent, run, reads: () => reads };
}

describe("balanceCheck", () => {
  it("reads balances at most once an hour", async () => {
    const r = rig(() => 5);
    assert.equal((await r.run(0)).ran, true);
    assert.equal((await r.run(BALANCE_CHECK_EVERY_MS - 1)).ran, false);
    assert.equal((await r.run(BALANCE_CHECK_EVERY_MS)).ran, true);
    assert.equal(r.reads(), 2);
  });

  it("mails a low balance once, not on every hourly run, then a reminder after 4 h and a recovery", async () => {
    let bal = 0.1;
    const r = rig(() => bal);
    await r.run(0);
    await r.run(H);
    await r.run(2 * H);
    assert.deepEqual(r.sent.map((a) => a.kind), ["alert"]);
    assert.match(r.sent[0].detail, /keeper on Solana.*0\.1 SOL.*KeepAddr/);
    await r.run(4 * H);
    assert.deepEqual(r.sent.map((a) => a.kind), ["alert", "reminder"]);
    bal = 2;
    await r.run(5 * H);
    assert.deepEqual(r.sent.map((a) => a.kind), ["alert", "reminder", "recovered"]);
  });

  it("an unreadable balance is not a low balance", async () => {
    const r = rig(() => Number.NaN);
    await r.run(0);
    assert.deepEqual(r.sent, []);
  });
});

describe("extraWatches", () => {
  it("reads label=address:min pairs for Fuel and other Solana accounts", () => {
    const w = extraWatches({ ALERT_EXTRA_SOL: "Duel Fuel=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:0.5, Burst Fuel=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB:1" });
    assert.deepEqual(w.map((x) => [x.key, x.label, x.address, x.min, x.net]), [
      ["balance:extra:Duel Fuel", "Duel Fuel", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", 0.5, "solana"],
      ["balance:extra:Burst Fuel", "Burst Fuel", "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", 1, "solana"],
    ]);
  });
  it("is empty when unset or malformed", () => {
    assert.deepEqual(extraWatches({}), []);
    assert.deepEqual(extraWatches({ ALERT_EXTRA_SOL: "nonsense" }), []);
  });
});
