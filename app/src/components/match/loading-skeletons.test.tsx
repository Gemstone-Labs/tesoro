import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchBannerSkeleton, ResultFilterSkeleton } from "./MatchBanner";
import { LoadingSkeleton } from "@/components/leaderboard/Leaderboard";
import { PAGE_SIZE, PODIUM } from "@/lib/chain/leaderboard-paging";

const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

describe("Matches loading skeleton", () => {
  const html = renderToStaticMarkup(<MatchBannerSkeleton count={3} label="Loading" />);
  it("uses the real banner's blocks: word column, two seats, chip", () => {
    expect(count(html, /class="cut cut-card mb skel"/g)).toBe(3);
    for (const cls of ["mb-word", "mb-kick", "mb-face", "mb-vs", "mb-fig", "mb-plate", "mb-av-wrap"]) expect(html).toContain(cls);
    expect(count(html, /class="mb-seat"/g)).toBe(6);
  });
  it("shows three result chips in the real chip row", () => {
    const chips = renderToStaticMarkup(<ResultFilterSkeleton />);
    expect(chips).toContain("mh-results");
    expect(count(chips, /mh-result skel-chip/g)).toBe(3);
  });
});

describe("Leaderboard loading skeleton", () => {
  const html = renderToStaticMarkup(<LoadingSkeleton />);
  it("follows the page: Pool band, three podium places, one page of rows", () => {
    expect(html).toContain("lb-band-wrap");
    expect(count(html, /lb-place p[123]/g)).toBe(PODIUM);
    expect(count(html, /class="cut cut-card lb-row[ "]/g)).toBe(PAGE_SIZE);
    expect(html.indexOf("lb-podium")).toBeLessThan(html.indexOf("lb-rows"));
  });
});
