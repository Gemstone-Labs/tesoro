import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { shape } from "@/test-utils/shape";
import { ChainPockets, PocketsSkeleton, type Pocket } from "./ChainPockets";

vi.mock("@/lib/chain/redeem-cost", () => ({ useRedeemCost: () => null }));
vi.mock("@/components/account/Player", () => ({ PlayerAvatar: () => null, PlayerName: () => null }));

const row = <article key="r" className="cut wl-row" aria-label="SOL Lock 1"><button type="button" className="wl-row-btn"><b>SOL Lock 1</b><span className="wl-row-p">40.000 SOL</span><span className="wl-row-when">Back today</span></button></article>;
const pocket = (chain: "SOL" | "HYPE", withLocks: boolean): Pocket => ({
  chain, gemas: 3500, gemasAsset: 0.3, redeemable: 0, redeemableAsset: 0, positions: withLocks ? [row] : [], closed: [], sources: [],
  readyBy: { rows: [{ at: 1_800_000_000, gemas: 2260n }], next: 1_800_000_000, last: 1_800_000_000 } as unknown as Pocket["readyBy"],
});

describe("Pro view loading skeleton", () => {
  it("has the loaded view's chain tabs and a Gemas card per chain with the same parts and classes", () => {
    const real = renderToStaticMarkup(<ChainPockets pockets={[pocket("SOL", true), pocket("HYPE", true)]} onRedeem={() => {}} />);
    expect(shape(renderToStaticMarkup(<PocketsSkeleton />))).toEqual(shape(real));
  });

  it("is one busy region with a single status line and no thin generic bars", () => {
    const html = renderToStaticMarkup(<PocketsSkeleton />);
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).not.toContain("skel-line");
  });
});
