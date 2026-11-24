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

  it("publishes the odds as the chance in the next second (1.9 / 6.9 / 13.1 in 100 at 10 / 25 / 45 s) and the share of rides over", () => {
    expect(html).toContain("no Bomb in the first 5 seconds");
    for (const row of ["10 s 1.9 in 100", "25 s 6.9 in 100", "45 s 13.1 in 100"]) expect(html).toContain(row);
    expect(html).toContain("Half of all rides are over by 25 seconds, and about 9 in 10 by 41 seconds");
    expect(html).toContain("About 1 ride in 190 passes a minute, and none passes 2 minutes");
    // No claim about what a clock-only Player earns or loses (Q40 review #6).
    expect(html).not.toMatch(/by the clock (loses|wins)|Gemas a ride/);
    expect(html).not.toContain("even chance");
  });

  it("publishes how often each Tell shows, its range, and that a later Tell is not promised", () => {
    for (const r of ["Glow screws pop Every ride 9 to 18 seconds", "Hot seams a bolt and a panel rattle 3 rides in 4 5 to 9 seconds", "White-hot sparks and a creak 2 rides in 3 3 to 5 seconds"]) expect(html).toContain(r);
    expect(html).toContain("When the White-hot Tell shows, it comes at least 3 seconds ahead");
    expect(html).toContain("On 1 ride in 12 the Glow is the only Tell");
    expect(html).toContain("the Bomb can go off with no further warning");
    expect(html).not.toContain("The last warning always comes");
  });

  it("an early Jump gets nothing: no refund schedule, only the last three are paid", () => {
    expect(html).toContain("Only the last three Jumps are paid");
    expect(html).toContain("a Player who Jumps earlier loses their entry, the same as a Player still aboard at Impact");
    expect(html).not.toMatch(/Early-jump refund|refund steps|80%|wall/i);
  });

  it("publishes the Prize fixed at departure and a pile that never adds to it (Q40 review #13)", () => {
    expect(html).toContain("It is fixed when the car leaves");
    expect(html).toContain("the Prize is 470");
    expect(html).toContain("it never adds to the Prize");
  });

  it("publishes the payout rule, the Points opponent, the Brake rule and the outage rule", () => {
    expect(html).toContain("60% / 25% / 15%");
    expect(html).toContain("70% / 30%");
    expect(html).toContain("against the earliest other Player to board");
    expect(html).toContain("Each Player has one Brake");
    expect(html).toContain("only that Player sees it");
    expect(html).toContain("never slower than half speed");
    expect(html).toContain("every entry is refunded");
    expect(html).toContain("no automatic Jump");
    expect(html).toContain("Starting a Break or Self-Exclusion while your car is still boarding steps you off it");
  });

  it("shows the worked example to the Gema: Dee 203, Ben 142, Cy 125, Ana 0, Eve 0, fees 30", () => {
    expect(html).toMatch(/Dee Last off 203 Ben Second-last off 142 Cy Third-last off 125 Ana Jumped early 0 Eve Aboard at the blast 0/);
    expect(html).toContain("Fees 30, and the total is 500");
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
    expect(t).toContain("Only the last three off are paid");
    expect(t).toContain("A Player's Brake is secret");
    expect(t).toContain("There is no automatic Jump");
  });

  it("Terms covers many-Player Matches, chance and the outage refund", () => {
    const t = text(<Terms />);
    expect(t).toContain("A Match can have two or more Players");
    expect(t).toContain("whether they Jumped earlier or were still aboard at Impact");
    expect(t).toContain("Railcar's Crash point is drawn at random");
    expect(t).toContain("A dropped connection does not Jump for you");
  });

  it("Help explains Railcar and points at the Docs", () => {
    const qs = TOPICS.flatMap((t) => t.qs);
    const q = qs.find((x) => x.q === "How does Railcar work?");
    expect(q).toBeDefined();
    const t = text(<>{q!.a}</>);
    expect(t).toContain("last three");
    expect(t).toContain("a Player who Jumps earlier loses their entry");
    expect(t).not.toMatch(/part of your entry|refund steps|not playable|wall/);
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
