import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));
vi.mock("@/components/brand", () => ({ TesoroLogo: () => null }));

import Privacy, { metadata as privacyMeta } from "./privacy/page";
import Terms, { metadata as termsMeta } from "./terms/page";
import { ENTITY, LEGAL_PLACEHOLDERS } from "@/lib/legal/entity";

describe("legal pages", () => {
  it("renders the Terms with the entity and its key sections", () => {
    const html = renderToStaticMarkup(<Terms />);
    expect(html).toContain(ENTITY.name);
    for (const id of ["eligibility", "gemas", "matches", "fair-play", "protections", "risks", "law"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("60%");
  });

  it("renders the Privacy Policy with its providers", () => {
    const html = renderToStaticMarkup(<Privacy />);
    for (const name of ["Privy", "Supabase", "Resend", "Vercel", "MagicBlock", "LayerZero"]) expect(html).toContain(name);
  });

  it("never shows the draft marker to Players", () => {
    const html = renderToStaticMarkup(<Terms />) + renderToStaticMarkup(<Privacy />);
    expect(html.toLowerCase()).not.toContain("legal review");
  });

  it("sets share images explicitly", () => {
    for (const m of [termsMeta, privacyMeta]) {
      expect(m.openGraph?.images).toBeTruthy();
      expect(m.twitter?.images).toBeTruthy();
    }
  });

  it("lists the placeholders to fill", () => {
    expect(LEGAL_PLACEHOLDERS.every((p) => p.startsWith("["))).toBe(true);
    expect(ENTITY.contactEmail).toBe("contact@playtesoro.com");
  });
});
