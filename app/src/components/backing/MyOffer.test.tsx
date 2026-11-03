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
