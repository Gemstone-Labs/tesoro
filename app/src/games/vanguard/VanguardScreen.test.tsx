import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TurnBox, type TurnInfo } from "./VanguardScreen";

const base: TurnInfo = { label: "Your turn", banked: 1, active: false, yourTurn: true, moved: false, onUse: () => undefined };
const html = (t: Partial<TurnInfo>) => renderToStaticMarkup(<TurnBox turn={{ ...base, ...t }} />);

describe("TurnBox", () => {
  it("shows an enabled Two-Step Turn button next to your turn once one is banked", () => {
    const h = html({});
    expect(h).toContain("Your turn");
    expect(h).toContain("Use Two-Step Turn");
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
  it("shows a Pass button in the power-button family on your turn, and a warning once only one missed turn is left", () => {
    const h = html({ pass: { onPress: () => undefined, warn: null } });
    expect(h).toContain("vg-power vg-pass");
    expect(h).not.toContain("miss once more");
    expect(html({ pass: { onPress: () => undefined, warn: "Pass again or miss once more and you lose." } })).toContain("Pass again or miss once more and you lose.");
  });
  it("offers no Pass on Italy's turn, inside a Two-Step Turn (the screen sends none) or with the Match over", () => {
    expect(html({ yourTurn: false, pass: { onPress: () => undefined, warn: null } })).not.toContain("vg-pass");
    expect(html({ pass: null })).not.toContain("vg-pass");
    expect(html({ label: "", pass: { onPress: () => undefined, warn: null } })).not.toContain("vg-pass");
  });
});
