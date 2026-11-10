import { PublicKey } from "@solana/web3.js";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
const acct = vi.hoisted(() => ({ snapshot: null as { waiting?: unknown[] } | null }));
vi.mock("@/lib/account", async (orig) => ({ ...(await orig<typeof import("@/lib/account")>()), useAccount: () => ({ auth: { signer: null }, snapshot: acct.snapshot, refresh: async () => undefined }) }));
import { DEE, workedResult } from "./fixtures";
import { RailcarScreen } from "./RailcarScreen";
import { RailcarWaiting } from "./RailcarWaiting";

const k = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const CAR = k(9);
const record = (n: number, match: PublicKey, gemas: bigint) => ({ address: k(n), owner: k(2), payer: k(3), kind: 0, match, gemas, lines: 1, storeLines: [], sources: [k(4)] });
const html = (props: { practice?: boolean; match?: PublicKey | null; view?: ReturnType<typeof workedResult> } = {}) =>
  renderToStaticMarkup(<RailcarScreen view={props.view ?? workedResult(DEE)} waiting={<RailcarWaiting match={props.match === undefined ? CAR : props.match} />} practice={props.practice} />);

describe("Railcar Result: Gemas waiting for room", () => {
  afterEach(() => {
    acct.snapshot = null;
  });
  it("says how many of this ride's Gemas wait, with a Claim, for this car's record only", () => {
    acct.snapshot = { waiting: [record(5, CAR, 95n), record(6, k(8), 71n)] };
    const h = html();
    expect(h).toContain("95 of these are waiting for room");
    expect(h).not.toContain("71 of these");
    expect(h).toContain(">Claim<");
  });
  it("sits in the header under the amount, before the track", () => {
    acct.snapshot = { waiting: [record(5, CAR, 95n)] };
    const h = html();
    const at = h.indexOf("of these are waiting for room");
    expect(at).toBeGreaterThan(h.indexOf("rc-res-gets"));
    expect(at).toBeLessThan(h.indexOf("rc-res-facts"));
  });
  it("shows nothing without a record of this car, an empty one, or a Result that is not mine", () => {
    acct.snapshot = { waiting: [record(6, k(8), 71n)] };
    expect(html()).not.toContain("waiting for room");
    acct.snapshot = { waiting: [record(5, CAR, 0n)] };
    expect(html()).not.toContain("waiting for room");
    acct.snapshot = null;
    expect(html()).not.toContain("waiting for room");
    acct.snapshot = { waiting: [record(5, CAR, 95n)] };
    expect(html({ match: null })).not.toContain("waiting for room");
  });
  it("never in Practice", () => {
    acct.snapshot = { waiting: [record(5, CAR, 95n)] };
    expect(html({ practice: true })).not.toContain("waiting for room");
  });
  it("not on someone else's Result (a watcher with no seat)", () => {
    acct.snapshot = { waiting: [record(5, CAR, 95n)] };
    expect(html({ view: workedResult(null) })).not.toContain("waiting for room");
  });
});
