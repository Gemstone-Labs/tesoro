import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PLAYERS, boardingCountdown, riding, rideShow } from "./fixtures";
import { CRASH_MS } from "./crash";
import { BOLT_ART, BoltPop, boltsDue, CarDamage, CRASH_ART, CrashMoment, CrashWall, DAMAGE_ART, DAMAGE_STAGES, MY_WINDOW, RailcarStage, WALL_ART, windowRiders } from "./RailcarStage";
import { RailcarScreen, TELLS } from "./RailcarScreen";
import { art } from "@/lib/art";
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

  it("the others fill the windows left to right in boarding order, after the Player's window", () => {
    const w = windowRiders([rider(1), rider(2), rider(3), rider(0, true)]);
    expect(w[0]?.me).toBe(true);
    expect([1, 2, 3].map((i) => w[i]?.account)).toEqual([1, 2, 3].map((i) => PLAYERS[i].toBase58()));
    expect(w.slice(4).every((r) => r === null)).toBe(true);
    // Practice riders (simulated) fill the same way
    const sim = windowRiders([{ account: "practice:a", seat: 2, me: false, name: "Ana" }, { account: "practice:you", seat: 1, me: true }, { account: "practice:b", seat: 3, me: false, name: "Ben" }]);
    expect(sim.map((r) => r?.account ?? null).slice(0, 4)).toEqual(["practice:you", "practice:a", "practice:b", null]);
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

  it("the picked frames play in order over the car, and replace the basic flash", () => {
    const h = renderToStaticMarkup(<CrashMoment />);
    const frames = [...h.matchAll(/data-frame="(\d)" src="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(frames.map((f) => f[0])).toEqual(["1", "2"]);
    expect(frames.map((f) => f[1])).toEqual(CRASH_ART);
    expect(CRASH_ART).toHaveLength(2);
    expect(h).not.toContain("rc-crash-flash");
    expect(h).toMatch(/rc-crash-frame f2 mid/);
    expect(h).not.toContain("rc-crash-frame f3");
    expect(renderToStaticMarkup(<CrashMoment art={[]} />)).toContain("rc-crash-flash");
  });

  it("the frames live in the car's box (registered to it), not the stage's", () => {
    const h = renderToStaticMarkup(<RailcarStage aboard={[]} moving={false} crash />);
    expect(h.indexOf("rc-car-art")).toBeLessThan(h.indexOf("rc-crash-frame"));
    expect(h).toMatch(/<div class="rc-car">.*rc-crash-frame.*<\/div><\/div>$/s);
  });
});

describe("the wall", () => {
  const css = readFileSync(new URL("./railcar.css", import.meta.url), "utf8");

  it("does not exist before the Impact; it enters with the crash, behind the car", () => {
    for (const h of [renderToStaticMarkup(<RailcarStage aboard={[]} moving tell={3} />), renderToStaticMarkup(<RailcarScreen view={riding()} />), renderToStaticMarkup(<RailcarScreen view={boardingCountdown()} />)]) {
      expect(h).not.toContain("rc-wall");
      expect(h).not.toContain("wall-v1");
      expect(h).not.toContain("wall-impact");
    }
    const h = renderToStaticMarkup(<RailcarStage aboard={[]} moving={false} crash />);
    expect(h).toContain('data-testid="rc-wall"');
    expect(h.indexOf("rc-wall")).toBeLessThan(h.indexOf("rc-car-art"));
  });

  it("has the intact sprite and the cracked one (new file names, both exist)", () => {
    const h = renderToStaticMarkup(<CrashWall />);
    expect(h).toMatch(/rc-wall-intact" src="\/art\/final\/railcar\/wall-v1\.webp/);
    expect(h).toMatch(/rc-wall-hit" src="\/art\/final\/railcar\/wall-impact-v1\.webp/);
    for (const url of Object.values(WALL_ART)) expect(existsSync(join(process.cwd(), "public", url)), url).toBe(true);
  });

  it("two rides with different crash points show the same screen until the earlier Impact", () => {
    const early = (ms: number) => renderToStaticMarkup(<RailcarScreen view={rideShow(ms, 2, [], PLAYERS[0], { crashMs: 70_000 })} />);
    const late = (ms: number) => renderToStaticMarkup(<RailcarScreen view={rideShow(ms, 2, [], PLAYERS[0], { crashMs: 118_000 })} />);
    for (const ms of [1_000, 30_000, 60_000, 69_000]) expect(early(ms)).toBe(late(ms));
    expect(early(60_000)).not.toContain("rc-wall");
  });

  it("the CSS: the wall rushes in 0.3 s while the car slides, the contact swaps the sprite, the hold is CRASH_MS, reduced motion has no rush", () => {
    expect(css).toMatch(/\.rc-wall \{[^}]*animation: rc-wall-in 0\.3s /);
    expect(css).toMatch(/\.rc-stage\.crash \.rc-car \{ animation: rc-car-slide 0\.3s /);
    expect(css).toMatch(new RegExp(`\\.rc-wall-hit \\{[^}]*animation: rc-wall-on ${CRASH_MS / 1000}s `));
    expect(css).toMatch(new RegExp(`\\.rc-crash-frame\\.f2 \\{ animation: rc-f2 ${CRASH_MS / 1000}s `));
    expect(css).toMatch(/prefers-reduced-motion[^]*\.rc-stage\.crash \.rc-car \{ animation: none; transform: translateX/);
  });
});

describe("the Screws bolts", () => {
  it("round 4's S-a overlay is the Screws damage, under a new file name (the image cache keeps old names)", () => {
    expect(DAMAGE_ART.screws).toBe("/art/final/railcar/damage-screws-v2.webp");
  });

  it("three bolts pop off the car, with the small sprites", () => {
    const h = renderToStaticMarkup(<BoltPop />);
    expect(h.match(/data-testid="rc-bolt"/g)).toHaveLength(3);
    for (const src of BOLT_ART) expect(h).toContain(src);
  });

  it("they pop when the Screws Tell fires while watching; not on a page that opens past it, not under reduced motion", () => {
    expect(boltsDue(0, 1, false)).toBe(true);
    expect(boltsDue(1, 2, false)).toBe(false);
    expect(boltsDue(1, 1, false)).toBe(false);
    expect(boltsDue(0, 1, true)).toBe(false);
    expect(renderToStaticMarkup(<RailcarStage aboard={[]} moving tell={1} />)).not.toContain("rc-bolt");
  });

  it("the CSS tumbles them back and down over about a second, and hides them under reduced motion", () => {
    const css = readFileSync(new URL("./railcar.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.rc-bolt \{[^}]*animation: rc-bolt 1s /);
    expect(css).toMatch(/prefers-reduced-motion[^]*\.rc-bolt \{ display: none; \}/);
  });
});

describe("the picked art is wired", () => {
  it("every Tell stage has its overlay, and every file exists", () => {
    for (const stage of DAMAGE_STAGES) expect(DAMAGE_ART[stage]).toMatch(new RegExp(`damage-${stage}(-v2)?\\.webp$`));
    for (const url of [...Object.values(DAMAGE_ART), ...CRASH_ART, ...BOLT_ART, ...Object.values(WALL_ART), "/art/final/railcar/tile-v2.webp", ...TELLS.map((t) => t.art)]) expect(existsSync(join(process.cwd(), "public", url!)), url).toBe(true);
  });

  it("each fired Tell adds its overlay and they stack; the sparks sit behind the wheels", () => {
    const h = renderToStaticMarkup(<RailcarStage aboard={[]} moving tell={3} />);
    for (const s of DAMAGE_STAGES) expect(h).toMatch(new RegExp(`damage-${s}(-v2)?\\.webp`));
    const at = (cls: string) => h.indexOf(`class="${cls}`);
    expect(at("rc-dmg rc-dmg-art rc-dmg-sparks")).toBeLessThan(at("rc-wheel"));
    expect(at("rc-dmg rc-dmg-art rc-dmg-screws")).toBeGreaterThan(at("rc-wheel"));
    expect(renderToStaticMarkup(<RailcarStage aboard={[]} moving tell={1} />)).not.toContain("damage-panel");
  });

  it("the Tell chips show the picked image: dimmed until fired, full colour after", () => {
    const h = renderToStaticMarkup(<RailcarScreen view={riding()} />);
    expect(h.match(/<img[^>]*tell-(screws|panel|sparks)\.webp/g)).toHaveLength(3);
    expect(h).toMatch(/rc-tell on[^>]*>.*?tell-screws/s);
    expect(h).toMatch(/<li class="cut cut-chip rc-tell"[^>]*>(?:(?!<\/li>).)*tell-panel/s);
    expect(readFileSync(new URL("./railcar.css", import.meta.url), "utf8")).toMatch(/\.rc-tell img \{[^}]*grayscale\(1\)/);
  });

  it("the Play tile is the new file name, so the image cache lets go of the old one", () => {
    expect(art.railcarTile).toBe("/art/final/railcar/tile-v2.webp");
  });
});
