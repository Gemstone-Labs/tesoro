import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PRO_VIEW_TIP, ProViewSwitch } from "./ProViewSwitch";

describe("Pro view switch", () => {
  it("is a labelled switch with an info tip", () => {
    const html = renderToStaticMarkup(<ProViewSwitch on={false} onChange={() => {}} />);
    expect(html).toContain("Pro view");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('aria-label="About Pro view"');
  });

  it("shows when it is on", () => {
    expect(renderToStaticMarkup(<ProViewSwitch on onChange={() => {}} />)).toContain('aria-checked="true"');
  });

  it("explains Pro view in the founder's words", () => {
    expect(PRO_VIEW_TIP).toBe("Deposit SOL, ETH or HYPE yourself: you choose how much and for how long.");
  });
});
