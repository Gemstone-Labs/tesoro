import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { shape } from "@/test-utils/shape";
import { BalanceHero } from "./BalanceHero";

const rows = [
  { label: "Redeemable now", figure: "200", usdOf: 200, emerald: true, info: "Ready now", action: <button>Redeem</button> },
  { label: "Pending", figure: "1,000", usdOf: 1000, info: "From deposits and wins", action: <button disabled>Instant Redeem</button>, note: "≈ $1.50 now" },
];

describe("shared Vault balance card", () => {
  it("shows Gemas and exactly two money rows with their dollar values and actions", () => {
    const html = renderToStaticMarkup(<BalanceHero label="Gemas" labelInfo="About Gemas" figure="1,200" usdOf={1200} rows={rows} />);
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

  it("replaces every pending figure with a skeleton and keeps in-play and error feedback", () => {
    const html = renderToStaticMarkup(<BalanceHero label="Gemas" figure="—" busy totalNote="In play: 100" rows={rows} error={<p role="alert">Read failed</p>} />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("In play: 100");
    expect(html).not.toContain("Simulated yield");
    expect(html).not.toContain("—");
    expect(html).not.toContain("≈ $1.50 now");
    expect(html).not.toContain("≈ $2");
    expect(html.match(/class="skel-text(?: wl-usd)?(?: wl-total-usd)?"/g)).toHaveLength(6);
    expect(html).not.toContain("skel-line");
    expect(html).toContain("Loading your Gemas…");
    expect(html).toContain('<p role="alert">Read failed</p>');
  });

  it("builds its loading card from the loaded card's own markup: same labels, rows, buttons and figure classes", () => {
    const noNotes = rows.map((r) => ({ ...r, note: undefined }));
    const loaded = renderToStaticMarkup(<BalanceHero label="Gemas" figure="5,700" usdOf={5700} rows={noNotes} />);
    const busy = renderToStaticMarkup(<BalanceHero label="Gemas" figure="—" busy rows={noNotes} />);
    expect(shape(busy)).toEqual(shape(loaded));
    expect(busy.match(/class="sr-only"/g)).toHaveLength(1);
  });
});
