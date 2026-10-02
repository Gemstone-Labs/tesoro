import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MatchRow } from "@/components/match/MatchRow";
import { match } from "@/lib/chain/fixture";
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

describe("MatchRow", () => {
  const row = historyRow(match("block-puzzle", 1000, true, 5, [120, 80]))!;

  it("opens the Match in the Account's own history", () => {
    const html = renderToStaticMarkup(<MatchRow r={row} now={Date.now()} />);
    expect(html).toMatch(/^<a [^>]*href="\/play\/match\//);
    expect(html).not.toContain("/account/");
  });

  it("on someone else's Account links the opponent and the Match side by side, never nested", () => {
    const html = renderToStaticMarkup(<MatchRow r={row} now={Date.now()} link="opponent" backing="Backed by Back…1111 · Backer +540" />);
    expect(html).toMatch(/^<div /);
    expect(html).toContain(`href="/account/${row.opp}"`);
    expect(html).toContain(`href="/play/match/${row.id}"`);
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).not.toMatch(/<a [^>]*>(?:(?!<\/a>).)*<a /);
    expect(html).toContain("Backer +540");
  });
});
