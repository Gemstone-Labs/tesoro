import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import Risks from "./page";

describe("Risks page", () => {
  it("says a rate fall after paid yield can leave the Locked amount short", () => {
    const html = renderToStaticMarkup(<Risks />).replace(/&#x27;|&apos;/g, "'");
    expect(html).toContain("If the staking token's rate falls after your yield was paid out, you get back what is left of your tokens, which can be worth less than the SOL you locked.");
  });
});
