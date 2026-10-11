import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchBanner } from "@/components/match/MatchBanner";
import { backed, match } from "@/lib/chain/fixture";
import { historyRow } from "@/lib/chain/history";
import { AccountLink } from "./AccountLink";

const KEY = "PlayerKey1111111111111111111111111111111111";

describe("AccountLink", () => {
  it("leads to the Player's Account, named by the short key", () => {
    const html = renderToStaticMarkup(<AccountLink account={KEY} />);
    expect(html).toContain(`href="/account/${KEY}"`);
    expect(html).toContain("Play…1111");
  });

  it("keeps a decorative avatar link out of the tab order", () => {
    expect(renderToStaticMarkup(<AccountLink account={KEY} decorative />)).toMatch(/tabindex="-1"[^>]*aria-hidden="true"|aria-hidden="true"[^>]*tabindex="-1"/);
  });
});

describe("MatchBanner", () => {
  const row = historyRow(match("block-puzzle", 1000, true, 5, [120, 80]))!;

  it("links the opponent and the Match side by side, never nested", () => {
    const html = renderToStaticMarkup(<MatchBanner r={row} account={KEY} now={Date.now()} backing="Backed by Back…1111 · Backer +540" />);
    expect(html).toMatch(/^<article /);
    expect(html).toContain(`href="/account/${row.opp}"`);
    expect(html).toContain(`href="/play/match/${row.id}"`);
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).not.toMatch(/<a [^>]*>(?:(?!<\/a>).)*<a /);
    expect(html).toContain("Backer +540");
    expect(html).toContain("120");
  });

  it("shows a backed Player's loss as 0 Gemas, not as an even result", () => {
    const lost = historyRow(match("holdem", 1000, false, 5, [0, 0]))!;
    const html = renderToStaticMarkup(<MatchBanner r={{ ...lost, delta: 0 }} account={KEY} now={Date.now()} />);
    expect(html).toContain("0 Gemas");
    expect(html).toContain("Lost");
  });

  it("on a Match the Account backed, seats the Player it backed and says so", () => {
    const m = match("block-puzzle", 2500, true, 300, [164, 97]);
    const r = historyRow(backed(m, KEY, 3000, true))!;
    expect(r.role).toBe("backer");
    const html = renderToStaticMarkup(<MatchBanner r={r} account={m.sides[0].player} now={Date.now()} />);
    expect(html).toContain(`href="/account/${KEY}"`);
    expect(html).toContain("You backed");
    expect(html.match(/<a /g)).toHaveLength(3);
  });
});
