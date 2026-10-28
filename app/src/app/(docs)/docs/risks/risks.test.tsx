import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import Risks from "./page";

describe("Risks page", () => {
  it("says a rate fall after paid yield can leave the Locked amount short", () => {
    const html = renderToStaticMarkup(<Risks />).replace(/&#x27;|&apos;/g, "'");
    expect(html).toContain("If the staking token's rate falls after your yield was paid out, you get back what is left of your tokens, which can be worth less than the SOL you locked.");
  });

  it("says the Treasury covers only growth, never a fall, and the limits on new Advances (ticket 55)", () => {
    const html = renderToStaticMarkup(<Risks />).replace(/&#x27;|&apos;/g, "'");
    expect(html).toContain("covers only the growth of tokens already paid out since their yield was priced, net of any fall since. It never covers a fall.");
    expect(html).toContain("A Lock's Advances can add up to at most its Principal over its life.");
    expect(html).toContain("After a fall, a new Advance or Extend waits until the rate is back above the highest rate your Lock's yield was priced at.");
  });
});
