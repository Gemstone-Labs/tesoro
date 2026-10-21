import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActionBar } from "./ActionBar";
import { newPractice } from "./practice/engine";

const t = newPractice(0, () => 0.5).table;
const bar = (busy: string | null, enabled = busy === null) =>
  renderToStaticMarkup(<ActionBar table={t} seat={t.toAct} enabled={enabled} busy={busy} onAct={() => {}} />);
const buttons = (html: string) => [...html.matchAll(/class="cut cut-btn hdx-btn[^"]*"[^>]*><span>([^<]*)<\/span>/g)].map((m) => m[1]);

describe("Hold'em action bar", () => {
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
});
