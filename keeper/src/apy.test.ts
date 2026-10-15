import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PUBLISH_EVERY_SECS, addSample, planApy, publishDue, trailingApyBps, type Sample } from "./apy.ts";

const DAY = 86_400;
const T0 = 1_800_000_000 - (1_800_000_000 % DAY);
const RATE = 1_200_000_000n;
/** A rate that grows `bpsPerDay` basis points of itself every day. */
const history = (days: number, bpsPerDay: bigint): Sample[] => {
  let out: Sample[] = [];
  for (let d = 0; d <= days; d++) out = addSample(out, T0 + d * DAY + 3600, RATE + (RATE * bpsPerDay * BigInt(d)) / 10_000n);
  return out;
};

describe("trailing APY", () => {
  it("scales the growth over the window to a year", () => {
    // 1 bp a day over 30 days = 0.30% growth = 3.65% a year = 365 bps.
    const s = history(30, 1n);
    assert.equal(trailingApyBps(s, T0 + 30 * DAY + 3600), 365);
    // The same rate over 10 days gives the same APY.
    assert.equal(trailingApyBps(history(10, 1n), T0 + 10 * DAY + 3600), 365);
  });

  it("uses only the last 30 days once there is more history", () => {
    let s: Sample[] = [];
    for (let d = 0; d <= 60; d++) {
      const bps = d <= 30 ? BigInt(d) * 10n : 300n + BigInt(d - 30);
      s = addSample(s, T0 + d * DAY + 3600, RATE + (RATE * bps) / 10_000n);
    }
    const apy = trailingApyBps(s, T0 + 60 * DAY + 3600)!;
    // Days 31..60 grew 1 bp a day, the 10 bp a day of the first month is gone.
    assert.ok(apy >= 340 && apy <= 380, String(apy));
    assert.ok(s.length <= 32, "samples older than the window are dropped");
  });

  it("needs at least 7 days of history", () => {
    assert.equal(trailingApyBps(history(6, 1n), T0 + 6 * DAY + 3600), null);
    assert.equal(trailingApyBps(history(7, 1n), T0 + 7 * DAY + 3600), 365);
    assert.equal(trailingApyBps([], T0), null);
    assert.equal(trailingApyBps(history(0, 1n), T0 + 3600), null);
  });

  it("is 0 when the rate fell and capped at 100%", () => {
    assert.equal(trailingApyBps(history(10, 0n), T0 + 10 * DAY + 3600), 0);
    const falling = addSample(addSample([], T0, RATE), T0 + 10 * DAY, RATE - 1n);
    assert.equal(trailingApyBps(falling, T0 + 10 * DAY), 0);
    const spike = addSample(addSample([], T0, RATE), T0 + 8 * DAY, RATE * 2n);
    assert.equal(trailingApyBps(spike, T0 + 8 * DAY), 10_000);
  });
});

describe("daily samples", () => {
  it("keeps one sample per UTC day, the latest of the day", () => {
    let s = addSample([], T0 + 100, 1n);
    s = addSample(s, T0 + 5000, 2n);
    s = addSample(s, T0 + DAY + 10, 3n);
    assert.deepEqual(s.map((x) => x.rate), ["2", "3"]);
  });
});

describe("publishing cadence", () => {
  it("publishes when nothing is on chain or the on-chain APY is about a day old", () => {
    assert.equal(publishDue(null, T0), true);
    assert.equal(publishDue(T0 - PUBLISH_EVERY_SECS + 60, T0), false);
    assert.equal(publishDue(T0 - PUBLISH_EVERY_SECS, T0), true);
  });

  it("plans nothing before 7 days of samples, then one publish a day", () => {
    let samples: Sample[] = [];
    let onchain: number | null = null;
    const published: number[] = [];
    for (let h = 0; h <= 10 * 24; h += 6) {
      const now = T0 + h * 3600;
      const plan = planApy(samples, now, RATE + (RATE * BigInt(h)) / 240_000n, onchain);
      samples = plan.samples;
      if (plan.publish) {
        published.push(h);
        onchain = now;
      }
    }
    assert.ok(published[0] >= 7 * 24, `first publish at hour ${published[0]}`);
    for (let i = 1; i < published.length; i++) assert.ok(published[i] - published[i - 1] >= 22, "at most once every 22 h");
    assert.ok(published.length >= 3 && published.length <= 4, String(published.length));
    assert.ok(samples.length <= 11, "one sample per day");
  });
});
