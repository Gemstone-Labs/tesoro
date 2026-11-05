import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MyOffer } from "./MyOffer";

vi.mock("@/components/account/Player", () => ({ PlayerName: () => "Ana" }));

const offer = (over = {}) => ({
  address: { toBase58: () => "OfferKey" },
  entry: 500, game: "block-puzzle", shareBps: 5000, status: "consumed", expiresAt: 0, useBy: 0,
  player: "ana", request: "r", lines: [], matchId: "opener-3", refundableMatchId: null, ...over,
});
const render = (o: object, busy: string | null = null) =>
  renderToStaticMarkup(<MyOffer offer={o as never} requests={new Map()} nowMs={0} busy={busy} onCancel={() => {}} onRelease={() => {}} onRefund={() => {}} />);

describe("My Backings: Refund Match", () => {
  it("shows the action on a used Offer whose Match nobody joined", () => {
    const html = render(offer({ refundableMatchId: "opener-3" }));
    expect(html).toContain("Refund Match");
    expect(html).toContain("Nobody joined this Match");
  });
  it("does not show it for a Match that is playing", () => {
    const html = render(offer());
    expect(html).not.toContain("Refund Match");
    expect(html).toContain("your Gemas are in the Pot");
  });
  it("shows progress while refunding", () => {
    expect(render(offer({ refundableMatchId: "opener-3" }), "rf-OfferKey")).toContain("Refunding…");
  });
});

describe("My Backings: a used Railcar Offer", () => {
  const ride = { id: "opener-9", game: "railcar", entry: 500, role: "backer", result: "won", delta: 78, backing: { other: "ana", shareBps: 4_000 }, scores: null, opp: null, at: 0, asset: null, ride: { seated: 5, kind: "place", place: 2, jumpMs: 97_000 } };
  const railcar = (r: object | null) =>
    renderToStaticMarkup(<MyOffer offer={offer({ game: "railcar", matchId: null }) as never} ride={r as never} requests={new Map()} nowMs={0} busy={null} onCancel={() => {}} onRelease={() => {}} onRefund={() => {}} />);

  it("links the ride it funded and says what it did with the Backer's Gemas: entry back first, then their share", () => {
    const html = railcar(ride);
    expect(html).toContain('href="/play/railcar/ride/opener-9"');
    expect(html).toContain("See the ride");
    expect(html).toContain("Second-last off at 1:37: your 500 back, then +78 of the winnings");
  });
  it("before the ride is in the history: boarded, and no link yet", () => {
    const html = railcar(null);
    expect(html).toContain("Boarded");
    expect(html).not.toContain("See the ride");
  });
});
