import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TurnBox, type TurnInfo } from "./VanguardScreen";

const base: TurnInfo = { label: "Your turn", banked: 1, active: false, yourTurn: true, moved: false, onUse: () => undefined };
const html = (t: Partial<TurnInfo>) => renderToStaticMarkup(<TurnBox turn={{ ...base, ...t }} />);

describe("TurnBox", () => {
  it("shows an enabled Two-Step Turn button next to your turn once one is banked", () => {
    const h = html({});
    expect(h).toContain("Your turn");
    expect(h).toMatch(/>Two-Step</);
    expect(h).toContain("move twice this turn");
    expect(h).not.toContain("disabled");
  });
  it("says to wait for your turn while Italy moves", () => {
    const h = html({ label: "Italy's turn", yourTurn: false });
    expect(h).toContain("Press it on your turn");
    expect(h).toContain("disabled");
  });
  it("says to press it before the first step", () => {
    expect(html({ moved: true })).toContain("before your first step");
  });
  it("shows no button with nothing banked, while one is being played, or when the Match is over", () => {
    expect(html({ banked: 0 })).not.toContain("Use Two-Step");
    expect(html({ active: true })).not.toContain("Use Two-Step");
    expect(html({ label: "" })).not.toContain("Use Two-Step");
  });
  it("has no Pass button (founder 2026-10-22): a turn is passed only by letting the clock run out", () => {
    expect(html({})).not.toMatch(/>Pass</);
  });
});
