import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BalanceHero } from "./BalanceHero";

const rows = [
  { label: "Redeemable now", figure: "200", usdOf: 200, emerald: true, info: "Ready now", action: <button>Redeem</button> },
  { label: "Pending", figure: "1,000", usdOf: 1000, info: "From deposits and wins", action: <button disabled>Instant Redeem</button>, note: "≈ $1.50 now" },
];

describe("shared Vault balance card", () => {
  it("shows Gemas and exactly two money rows with their dollar values and actions", () => {
    const html = renderToStaticMarkup(<BalanceHero label="Gemas" labelInfo="About Gemas" figure="1,200" usdOf={1200} simulated={false} rows={rows} />);
    for (const label of ["Gemas", "Redeemable now", "Pending"]) {
      expect(html).toContain(`aria-label="${label}"`);
      expect(html).toContain(`aria-label="About ${label}"`);
    }
    expect(html.match(/class="wl-win(?: emerald)?"/g)).toHaveLength(2);
    expect(html).toContain("$12");
    expect(html).toContain("$2");
    expect(html).toContain("$10");
    expect(html).toContain("Redeem</button>");
    expect(html).toContain('<button disabled="">Instant Redeem</button>');
    expect(html).toContain("≈ $1.50 now");
    expect(html).not.toMatch(/Winnings|Cash out|Your pending|Won pending|wl-fold|wl-second|simulated yield/);
  });

  it("keeps loading, in-play, simulated-yield and error feedback visible", () => {
    const html = renderToStaticMarkup(<BalanceHero label="Gemas" figure="—" busy totalNote="In play: 100" rows={rows} error={<p role="alert">Read failed</p>} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("In play: 100");
    expect(html).toContain("Simulated yield");
    expect(html).toContain('<p role="alert">Read failed</p>');
  });
});
