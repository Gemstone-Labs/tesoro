import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PLAYERS, boardingCountdown, riding } from "./fixtures";
import { CarDamage, CrashMoment, DAMAGE_STAGES, MY_WINDOW, RailcarStage, windowRiders } from "./RailcarStage";
import { RailcarScreen } from "./RailcarScreen";
import type { Rider } from "./view";

const rider = (i: number, me = false): Rider => ({ account: PLAYERS[i].toBase58(), seat: i + 1, me });

describe("who sits where in the car", () => {
  it("the Player always sits in the last seat, the window nearest the back of the car, whoever else boards", () => {
    for (const n of [0, 1, 4, 11, 40]) {
      const riders = [...Array.from({ length: n }, (_, i) => rider(i + 1)), rider(0, true)];
      const w = windowRiders(riders);
      expect(w[MY_WINDOW]?.me).toBe(true);
      expect(w.filter((r) => r?.me)).toHaveLength(1);
    }
    expect(MY_WINDOW).toBe(0);
  });

  it("the others fill the windows from the front, in seat order", () => {
    const w = windowRiders([rider(1), rider(2), rider(0, true)]);
    expect(w[11]?.account).toBe(PLAYERS[1].toBase58());
    expect(w[10]?.account).toBe(PLAYERS[2].toBase58());
    expect(w[0]?.me).toBe(true);
    expect(w.filter(Boolean)).toHaveLength(3);
  });

  it("in Boarding, the ride and Practice the same window", () => {
    const html = (v: Parameters<typeof RailcarScreen>[0]["view"]) => renderToStaticMarkup(<RailcarScreen view={v} />);
    for (const v of [boardingCountdown(PLAYERS[13]), riding(PLAYERS[0])]) {
      const first = html(v).match(/<span class="rc-win[^"]*"[^>]*>/g) ?? [];
      expect(first[0]).toContain("on me");
    }
  });
});

describe("the avatars in the windows", () => {
  it("come from the same source as the riders row (PlayerAvatar), not a separate derivation", () => {
    const html = renderToStaticMarkup(<RailcarStage aboard={[rider(0, true)]} moving={false} />);
    const row = renderToStaticMarkup(<RailcarScreen view={boardingCountdown(PLAYERS[0])} />);
    const src = (h: string, scope: string) => h.match(new RegExp(`${scope}[^]*?<img[^>]*src="([^"]+)"`))?.[1]?.replace(/&amp;w=\d+/, "");
    expect(src(html, 'rc-win on me')).toBeTruthy();
    expect(src(html, 'rc-win on me')).toBe(src(row, 'rc-rider me'));
  });
});

describe("the Tells on the train", () => {
  const stages = (tell: number) => [...renderToStaticMarkup(<CarDamage tell={tell} />).matchAll(/data-tell="(\w+)"/g)].map((m) => m[1]);

  it("each Tell changes the car from the moment it fires, and stays", () => {
    expect(stages(0)).toEqual([]);
    expect(stages(1)).toEqual(["screws"]);
    expect(stages(2)).toEqual(["screws", "panel"]);
    expect(stages(3)).toEqual(["screws", "panel", "sparks"]);
    expect([...DAMAGE_STAGES]).toEqual(["screws", "panel", "sparks"]);
  });

  it("the stage draws them from the ride's Tell count; Boarding never does", () => {
    const html = (tell: number) => renderToStaticMarkup(<RailcarStage aboard={[]} moving tell={tell} />);
    expect(html(2)).toContain('data-tell="panel"');
    expect(html(1)).not.toContain('data-tell="panel"');
    expect(renderToStaticMarkup(<RailcarScreen view={boardingCountdown()} />)).not.toContain("data-tell");
    expect(renderToStaticMarkup(<RailcarScreen view={riding()} />)).toContain('data-tell="screws"');
  });

  it("picked art replaces a stage's basic visual with an overlay of the car's size", () => {
    const h = renderToStaticMarkup(<CarDamage tell={3} art={{ panel: "/art/final/railcar/panel-loose.webp" }} />);
    expect(h).toMatch(/<img[^>]*data-tell="panel"[^>]*src="\/art\/final\/railcar\/panel-loose\.webp"/);
    expect(h).toMatch(/<span[^>]*data-tell="screws"/);
  });
});

describe("the crash", () => {
  it("the stage plays the impact: the car stops (not moving) and the crash layer shows", () => {
    const h = renderToStaticMarkup(<RailcarStage aboard={[]} moving={false} crash />);
    expect(h).toContain("rc-stage crash");
    expect(h).toContain('data-testid="rc-crash"');
    expect(renderToStaticMarkup(<RailcarStage aboard={[]} moving />)).not.toContain("rc-crash");
  });

  it("picked art replaces the basic flash", () => {
    const h = renderToStaticMarkup(<CrashMoment art="/art/final/railcar/crash.webp" />);
    expect(h).toContain('src="/art/final/railcar/crash.webp"');
    expect(h).not.toContain("rc-crash-flash");
    expect(renderToStaticMarkup(<CrashMoment />)).toContain("rc-crash-flash");
  });
});
