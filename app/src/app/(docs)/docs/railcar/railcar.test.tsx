import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, describe, expect, it, vi } from "vitest";

// Railcar shows only where NEXT_PUBLIC_SHOW_RAILCAR=1; these pages are read with it on (it is read when the modules load).
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SHOW_RAILCAR = "1";
});

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

import Railcar from "./page";
import Risks from "../risks/page";
import Terms from "../../../(legal)/terms/page";
import { TOPICS } from "../../../(app)/help/help-content";

vi.mock("@/components/brand", () => ({ TesoroLogo: () => null }));

const text = (node: React.ReactElement) => renderToStaticMarkup(node).replace(/&#x27;|&apos;/g, "'").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("Railcar docs page", () => {
  const html = text(<Railcar />);

  it("publishes the crash odds in plain words", () => {
    expect(html).toContain("no crash in the first 10 seconds");
    expect(html).toContain("an even chance every second");
    expect(html).toContain("Half of all rides are over by 40 seconds");
    expect(html).toContain("certain by 2 minutes");
  });

  it("publishes the Tell ranges and the 3 second last warning", () => {
    for (const r of ["20 to 40 seconds", "8 to 15 seconds", "3 to 8 seconds"]) expect(html).toContain(r);
    expect(html).toContain("at least 3 seconds");
  });

  it("publishes the refund schedule, payout rule, Brake rule and outage rule", () => {
    for (const row of ["Up to 20 s 80%", "20 to 30 s 70%", "80 to 90 s 10%", "90 to 100 s 5%", "After 100 s 0%"]) expect(html).toContain(row);
    expect(html).toContain("60% / 25% / 15%");
    expect(html).toContain("70% / 30%");
    expect(html).toContain("Each Player has one Brake");
    expect(html).toContain("only that Player sees it");
    expect(html).toContain("never slower than half speed");
    expect(html).toContain("every entry is refunded");
    expect(html).toContain("no automatic Jump");
  });

  it("shows the worked example to the Gema", () => {
    for (const n of ["2,500", "2,150", "129", "521", "813", "630", "578", "350"]) expect(html).toContain(n);
  });

  it("where Railcar is shown it is playable: links to Play and Practice free, no 'not playable' notice", () => {
    const raw = renderToStaticMarkup(<Railcar />);
    expect(raw).toMatch(/<a href="\/play\/railcar">[^<]*Play[^<]*<\/a>/);
    expect(raw).toMatch(/<a href="\/play\/practice\?game=railcar">Practice free<\/a>/);
    expect(html).not.toMatch(/not playable/i);
    expect(html.toLowerCase()).not.toContain("mainnet");
  });
});

describe("where Railcar is not shown (Production)", () => {
  it("the rulebook is a 404", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SHOW_RAILCAR", "");
    const { default: Hidden } = await import("./page");
    expect(() => Hidden()).toThrow(expect.objectContaining({ digest: expect.stringContaining("NEXT_HTTP_ERROR_FALLBACK;404") }));
    vi.unstubAllEnvs();
  });
});

describe("Risks, Terms and Help carry the Railcar lines", () => {
  it("Risks says the crash point is random, Brakes are secret and there is no automatic Jump", () => {
    const t = text(<Risks />);
    expect(t).toContain("Railcar's Crash point is random");
    expect(t).toContain("A Player's Brake is secret");
    expect(t).toContain("There is no automatic Jump");
  });

  it("Terms covers many-Player Matches, chance and the outage refund", () => {
    const t = text(<Terms />);
    expect(t).toContain("A Match can have two or more Players");
    expect(t).toContain("Railcar's Crash point is drawn at random");
    expect(t).toContain("A dropped connection does not Jump for you");
  });

  it("Help explains Railcar and points at the Docs", () => {
    const qs = TOPICS.flatMap((t) => t.qs);
    const q = qs.find((x) => x.q === "How does Railcar work?");
    expect(q).toBeDefined();
    const t = text(<>{q!.a}</>);
    expect(t).toContain("last three");
  });
});

describe("Railcar before launch", () => {
  afterAll(() => {
    process.env.NEXT_PUBLIC_SHOW_RAILCAR = "1";
    vi.resetModules();
  });

  it("is a 404 and leaves Help, Risks and Terms without Railcar when NEXT_PUBLIC_SHOW_RAILCAR is unset", async () => {
    delete process.env.NEXT_PUBLIC_SHOW_RAILCAR;
    vi.resetModules();
    const page = (await import("./page")).default;
    expect(() => renderToStaticMarkup(page())).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/);
    const risks = (await import("../risks/page")).default;
    const terms = (await import("../../../(legal)/terms/page")).default;
    const { TOPICS: topics } = await import("../../../(app)/help/help-content");
    expect(text(risks())).not.toContain("Railcar");
    expect(text(terms())).not.toContain("Railcar");
    expect(topics.flatMap((t) => t.qs.map((q) => q.q)).join(" ")).not.toContain("Railcar");
  });
});
