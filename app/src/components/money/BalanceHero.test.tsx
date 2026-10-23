import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BalanceHero } from "./BalanceHero";

// Check the component contract without changing the money actions supplied by its caller.
describe("shared Vault balance card", () => {
  it("renders the Simple view's Winnings and Cash out in an always-visible row", () => {
    const html = renderToStaticMarkup(<BalanceHero label="Gemas" figure="1,200" simulated={false} rows={[{ label: "Winnings", figure: "200", action: <button disabled>Cash out</button> }]} />);
    expect(html).toContain('aria-label="Winnings"');
    expect(html).toContain('disabled=""');
    expect(html).toContain("Cash out");
    expect(html).not.toMatch(/wl-fold|wl-second|aria-expanded|simulated yield/);
  });
  it("keeps all Pro rows, label info, notes and action states visible without a fold", () => {
    const html = renderToStaticMarkup(<BalanceHero label="Total Balance" labelInfo="About this total" figure="—" busy totalNote="In play: 100" rows={[
      { label: "Redeemable now", figure: "100", emerald: true, info: "Ready now", action: <button>Redeem</button> },
      { label: "Your pending", figure: "800", info: "Own earnings" },
      { label: "Won pending", figure: "200", info: "Won earnings", action: <button disabled>Instant Redeem</button>, note: "≈ $1.50 now" },
    ]} />);
    for (const label of ["Total Balance", "Redeemable now", "Your pending", "Won pending"]) expect(html).toContain(`aria-label="About ${label}"`);
    expect(html).toContain("In play: 100");
    expect(html).toContain("≈ $1.50 now");
    expect(html.match(/<button(?![^>]*tip-btn)/g)).toHaveLength(2);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toMatch(/wl-fold|wl-second/);
  });
});
