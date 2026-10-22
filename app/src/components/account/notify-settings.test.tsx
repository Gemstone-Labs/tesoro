import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotifySettingsView } from "./NotifySettings";

const noop = () => {};

describe("NotifySettingsView", () => {
  it("says Loading while the settings load", () => {
    const html = renderToStaticMarkup(<NotifySettingsView status={null} draft="" onDraft={noop} onSave={noop} onToggle={noop} />);
    expect(html).toContain("Loading…");
  });

  it("stops saying Loading once the read failed", () => {
    const html = renderToStaticMarkup(<NotifySettingsView status={null} error="That didn’t go through." draft="" onDraft={noop} onSave={noop} onToggle={noop} />);
    expect(html).not.toContain("Loading…");
    expect(html).toContain("That didn’t go through.");
  });
});
