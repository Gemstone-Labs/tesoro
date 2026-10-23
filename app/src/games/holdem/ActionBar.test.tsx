import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionBar, actionShortcut } from "./ActionBar";
import { newPractice } from "./practice/engine";

const t = newPractice(0, () => 0.5).table;
const bar = (busy: string | null, enabled = busy === null) =>
  renderToStaticMarkup(<ActionBar table={t} seat={t.toAct} enabled={enabled} busy={busy} onAct={() => {}} />);
const buttons = (html: string) => [...html.matchAll(/class="cut cut-btn hdx-btn[^"]*"[^>]*><span>([^<]*)<\/span>/g)].map((m) => m[1]);

describe("Hold'em action bar", () => {
  it("folds with G and leaves F for the window cover", () => {
    expect(actionShortcut("g")).toBe("fold");
    expect(actionShortcut("G")).toBe("fold");
    expect(actionShortcut("f")).toBeNull();
    expect(actionShortcut("F")).toBeNull();
    expect(bar(null)).toContain('<kbd aria-hidden="true">G</kbd>');
  });

  it("has no line under the buttons while waiting for a turn", () => {
    const html = bar(null, false);
    expect(html).not.toContain("Actions unlock");
    expect(html).not.toContain("hd-hint");
  });

  it.each([
    ["fold", 0],
    ["call 50", 1],
    ["check", 1],
    ["raise to 400", 2],
    ["bet to 200", 2],
  ])("shows %s as Sending… on the pressed button, not on a new line", (busy, at) => {
    const html = bar(busy);
    const labels = buttons(html);
    expect(labels).toHaveLength(3);
    labels.forEach((l, i) => (i === at ? expect(l).toBe("Sending…") : expect(l).not.toBe("Sending…")));
    expect(html).not.toContain("hd-hint");
  });

  it("leaves the buttons alone while claiming a timeout", () => {
    expect(buttons(bar("claim_timeout"))).not.toContain("Sending…");
  });

  it("offers raise by 200 / 400 / 600 / 800 and All-in, with no typed amount or slider", () => {
    const html = bar(null);
    const presets = [...html.matchAll(/class="cut cut-chip hd-preset"[^>]*>([^<]*)/g)].map((m) => m[1]);
    expect(presets).toEqual(["+200", "+400", "+600", "+800", "All-in "]);
    expect(html).not.toContain("<input");
    expect(html).toContain("Raise by");
  });

  it("starts on the smallest legal preset and names the raise-to it sends", () => {
    // Hand 1 at 50/100: the small blind faces 100, so +200 raises to 300.
    const html = bar(null);
    expect(html).toMatch(/aria-pressed="true"[^>]*>\+200</);
    expect(buttons(html)[2]).toBe("Raise to 300");
  });
});
