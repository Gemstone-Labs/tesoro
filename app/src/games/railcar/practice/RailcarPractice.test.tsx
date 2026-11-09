import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { boardingCountdown, boardingNotAboard } from "../fixtures";
import { RailcarScreen } from "../RailcarScreen";
import { practiceHref } from "@/lib/game-params";
import { newPractice, practiceJump, practiceView, type PracticeRider } from "./session";

const LONG = new Uint8Array(32);
const rider = (name: string, planMs: number): PracticeRider => ({ id: `practice:${name}`, name, planMs, boltReactMs: null, sparkReactMs: null });
const worked = () => newPractice(LONG, [rider("Ana", 25_000), rider("Ben", 97_000), rider("Cy", 95_000), rider("Eve", 1_000_000)]);

const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const practice = (v: ReturnType<typeof practiceView>) => renderToStaticMarkup(<RailcarScreen view={v} practice actions={{ onJump: () => {}, onPlayAgain: () => {} }} />);

describe("the Railcar screen in Practice", () => {
  it("the Ride carries the Practice tag and the simulated riders' names, with Jump", () => {
    const t = text(practice(practiceView(worked(), 30_000)));
    expect(t).toMatch(/Railcar .*Practice/);
    expect(t).toContain("0:30");
    expect(t).toContain("Aboard 4");
    for (const name of ["You", "Ben", "Cy", "Eve"]) expect(t).toContain(name);
    expect(t).not.toContain("Ana");
    expect(t).toContain("Jump");
    expect(t).not.toMatch(/Sign in|wallet/i);
  });

  it("the Result shows the place and what a 500 entry would have paid, then Play again; no Share", () => {
    const t = text(practice(practiceView(practiceJump(worked(), 99_000), 120_000)));
    expect(t).toContain("Practice");
    expect(t).toContain("Last off");
    expect(t).toMatch(/A .*500 entry would have paid .*813/);
    expect(t).toMatch(/Ben .*630/);
    expect(t).toMatch(/Fees .*129/);
    expect(t).toContain("Play again");
    expect(t).toContain("Ride for real");
    expect(t).not.toContain("Share");
    expect(t).not.toContain("You get");
  });

  it("a real ride's Result never says Practice", () => {
    const t = text(renderToStaticMarkup(<RailcarScreen view={practiceView(practiceJump(worked(), 99_000), 120_000)} actions={{ onShare: () => {} }} />));
    expect(t).not.toContain("Practice");
    expect(t).toContain("You get");
    expect(t).toContain("Share");
  });
});

describe("Practice free, wherever Railcar is shown", () => {
  it("links to the Railcar Practice page", () => {
    expect(practiceHref("railcar")).toBe("/play/practice?game=railcar");
  });

  it("is on the Railcar page before boarding, and gone once you hold a seat", () => {
    expect(renderToStaticMarkup(<RailcarScreen view={boardingNotAboard()} />)).toMatch(/href="\/play\/practice\?game=railcar"[^>]*>.*Practice free/);
    expect(renderToStaticMarkup(<RailcarScreen view={boardingCountdown()} />)).not.toContain("Practice free");
  });

  it("is on the Railcar tile of Play", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SHOW_RAILCAR", "1");
    vi.doMock("@/components/lobby/useQueue", () => ({ useQueue: () => null }));
    vi.doMock("@/lib/account", () => ({ useAccount: () => ({ auth: { status: "signed-out" }, snapshot: null }) }));
    const { GameGrid } = await import("@/components/lobby/GameGrid");
    const html = renderToStaticMarkup(<GameGrid />);
    expect(html).toContain('class="cut cut-chip game-practice" href="/play/practice?game=railcar"');
    vi.unstubAllEnvs();
    vi.doUnmock("@/components/lobby/useQueue");
    vi.doUnmock("@/lib/account");
  });
});

describe("the Practice page", () => {
  it("covers the window from the start, in Railcar's Arena, like every Game's Practice", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SHOW_RAILCAR", "1");
    const { default: Practice } = await import("@/app/(app)/play/practice/page");
    const { Arena } = await import("@/games/fx");
    const { RailcarPractice } = await import("./RailcarPractice");
    const page = await Practice({ searchParams: Promise.resolve({ game: "railcar" }) } as Parameters<typeof Practice>[0]);
    expect(page.type).toBe(Arena);
    expect(page.props).toMatchObject({ game: "railcar", autoFull: true });
    expect(page.props.children.type).toBe(RailcarPractice);
    vi.unstubAllEnvs();
  });
});
