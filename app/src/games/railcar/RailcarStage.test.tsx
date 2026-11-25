import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PLAYERS, boardingCountdown, riding, rideShow } from "./fixtures";
import { CRASH_MS } from "./crash";
import { tellsUpTo, type Tells } from "./tell-state";
import { BLAST_ART, BLAST_H, BLAST_TOP, CarDamage, CrashMoment, DAMAGE_ART, DAMAGE_STAGES, GlowPulse, MY_WINDOW, pulseDue, RailcarStage, windowRiders } from "./RailcarStage";
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

describe("the bomb's warnings on the train", () => {
  const marks = (tells: Tells) => [...renderToStaticMarkup(<CarDamage tells={tells} />).matchAll(/data-tell="(\w+)"/g)].map((m) => m[1]);
  const stages = (n: number) => marks(tellsUpTo(n));

  it("the car glows for the latest Tell shown, from the moment it fires; each layer already holds the earlier light", () => {
    expect(stages(0)).toEqual([]);
    expect(stages(1)).toEqual(["screws"]);
    expect(stages(2)).toEqual(["panel"]);
    expect(stages(3)).toEqual(["sparks"]);
    expect([...DAMAGE_STAGES]).toEqual(["screws", "panel", "sparks"]);
  });

  it("a Tell the ride never shows never marks the car: sparks with no panel, screws alone (decisions Q39)", () => {
    expect(marks({ screws: 1, panel: false, sparks: true })).toEqual(["sparks"]);
    expect(marks({ screws: 4, panel: false, sparks: false })).toEqual(["screws"]);
    expect(marks({ screws: 1, panel: true, sparks: false })).toEqual(["panel"]);
  });

  it("the first glow heard marks the car, false or real: nothing on the car says which", () => {
    expect(marks({ screws: 1, panel: false, sparks: false })).toEqual(marks({ screws: 3, panel: false, sparks: false }));
  });

  it("the stage draws it from the ride's Tells; Boarding never does", () => {
    const html = (n: number) => renderToStaticMarkup(<RailcarStage aboard={[]} moving tells={tellsUpTo(n)} />);
    expect(html(2)).toContain('data-tell="panel"');
    expect(html(1)).not.toContain('data-tell="panel"');
    expect(renderToStaticMarkup(<RailcarScreen view={boardingCountdown()} />)).not.toContain("data-tell");
    expect(renderToStaticMarkup(<RailcarScreen view={riding()} />)).toContain('data-tell="screws"');
  });

  it("the light is an overlay of the car's size, under the riders' windows and the wheels, never a bomb", () => {
    const h = renderToStaticMarkup(<RailcarStage aboard={[]} moving tells={tellsUpTo(3)} />);
    expect(h).toContain("/art/final/railcar/bomb-warn-3.webp");
    expect(h).not.toContain("bomb-warn-2");
    const at = (cls: string) => h.indexOf(`class="${cls}`);
    expect(at("rc-dmg rc-dmg-sparks")).toBeGreaterThan(at("rc-car-art"));
    expect(at("rc-dmg rc-dmg-sparks")).toBeLessThan(at("rc-win"));
    expect(at("rc-dmg rc-dmg-sparks")).toBeLessThan(at("rc-wheel"));
  });

  it("a custom overlay replaces the picked one", () => {
    const h = renderToStaticMarkup(<CarDamage tells={tellsUpTo(2)} art={{ screws: "/a.webp", panel: "/b.webp", sparks: "/c.webp" }} />);
    expect(h).toMatch(/<img[^>]*data-tell="panel"[^>]*src="\/b\.webp"/);
  });
});

describe("the explosion", () => {
  const css = readFileSync(new URL("./railcar.css", import.meta.url), "utf8");

  it("the stage plays it: the car stops (not moving) and the blast layer shows", () => {
    const h = renderToStaticMarkup(<RailcarStage aboard={[]} moving={false} crash />);
    expect(h).toContain("rc-stage crash");
    expect(h).toContain('data-testid="rc-crash"');
    expect(renderToStaticMarkup(<RailcarStage aboard={[]} moving />)).not.toContain("rc-crash");
  });

  it("there is no wall: not before, not during", () => {
    for (const h of [renderToStaticMarkup(<RailcarStage aboard={[]} moving={false} crash />), renderToStaticMarkup(<RailcarScreen view={riding()} />)]) {
      expect(h).not.toContain("rc-wall");
      expect(h).not.toContain("wall-");
    }
    expect(css).not.toContain("rc-wall");
  });

  it("two rides with different bomb times show the same screen until the earlier blast", () => {
    const early = (ms: number) => renderToStaticMarkup(<RailcarScreen view={rideShow(ms, 2, [], PLAYERS[0], { crashMs: 70_000 })} />);
    const late = (ms: number) => renderToStaticMarkup(<RailcarScreen view={rideShow(ms, 2, [], PLAYERS[0], { crashMs: 118_000 })} />);
    for (const ms of [1_000, 30_000, 60_000, 69_000]) expect(early(ms)).toBe(late(ms));
    expect(early(60_000)).not.toContain("rc-crash");
  });

  it("the three frames play in order: windows blow out, the blast, the wreck (the last is the reduced-motion frame)", () => {
    const h = renderToStaticMarkup(<CrashMoment />);
    const frames = [...h.matchAll(/data-frame="(\d)" src="([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(frames.map((f) => f[0])).toEqual(["1", "2", "3"]);
    expect(frames.map((f) => f[1])).toEqual(BLAST_ART);
    expect(h).toMatch(/rc-crash-frame f3 last/);
    expect(h).not.toMatch(/rc-crash-frame f2 last/);
  });

  it("the frames live in the car's box (registered to it), reaching BLAST_TOP above it, which the stage lets out while it plays", () => {
    const h = renderToStaticMarkup(<RailcarStage aboard={[]} moving={false} crash />);
    expect(h.indexOf("rc-car-art")).toBeLessThan(h.indexOf("rc-crash-frame"));
    expect(h).toMatch(/<div class="rc-car">.*rc-crash-frame.*<\/div><\/div>$/s);
    expect(css).toContain(`top: -${((BLAST_TOP / 351) * 100).toFixed(2)}%`);
    expect(css).toContain(`aspect-ratio: 1068 / ${BLAST_H}`);
    expect(css).toMatch(/\.rc-stage\.crash \{ overflow-x: clip; overflow-y: visible; \}/);
    expect(css).toContain(`aspect-ratio: 1068 / ${BLAST_H}`);
  });

  it("the CSS: the hold is CRASH_MS, the car is hidden under the frames, reduced motion shows the wreck only", () => {
    expect(css).toMatch(new RegExp(`\\.rc-crash-frame\\.f2 \\{ animation: rc-f2 ${CRASH_MS / 1000}s `));
    expect(css).toMatch(/\.rc-stage\.crash \.rc-car-art[^}]*visibility: hidden/);
    expect(css).toMatch(/prefers-reduced-motion[^]*\.rc-crash-frame:not\(\.last\) \{ display: none; \}/);
  });
});

describe("the glow flare", () => {
  it("flares at every screw heard while watching, false or real alike; not on a page that opens past it, not under reduced motion", () => {
    expect(pulseDue(0, 1, false)).toBe(true);
    expect(pulseDue(1, 2, false)).toBe(true);
    expect(pulseDue(1, 1, false)).toBe(false);
    expect(pulseDue(0, 1, true)).toBe(false);
    expect(renderToStaticMarkup(<RailcarStage aboard={[]} moving tells={tellsUpTo(1)} />)).not.toContain("rc-glow-pulse");
  });

  it("is the first glow's image, and the CSS fades it in a second and hides it under reduced motion", () => {
    const h = renderToStaticMarkup(<GlowPulse />);
    expect(h).toContain(DAMAGE_ART.screws);
    const css = readFileSync(new URL("./railcar.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.rc-glow-pulse \{[^}]*animation: rc-pulse 1s /);
    expect(css).toMatch(/prefers-reduced-motion[^]*\.rc-glow-pulse \{ display: none; \}/);
  });

  it("holds the White-hot car still: no flicker or shake (founder 2026-11-25)", () => {
    const css = readFileSync(new URL("./railcar.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/\.rc-dmg-sparks/);
    expect(css).not.toContain("rc-flick");
  });
});

describe("the picked art is wired", () => {
  it("every stage has its overlay under a new file name, and every file exists", () => {
    for (const stage of DAMAGE_STAGES) expect(DAMAGE_ART[stage]).toMatch(/bomb-warn-\d\.webp$/);
    for (const url of [...Object.values(DAMAGE_ART), ...BLAST_ART, "/art/final/railcar/tile-v2.webp", ...TELLS.map((t) => t.art)]) expect(existsSync(join(process.cwd(), "public", url)), url).toBe(true);
  });

  it("the chips show the picked images in bomb words: dimmed until fired, full colour after", () => {
    const h = renderToStaticMarkup(<RailcarScreen view={riding()} />);
    expect(h.match(/<img[^>]*bomb-tell-\d\.webp/g)).toHaveLength(3);
    expect(h).toMatch(/rc-tell on[^>]*>.*?bomb-tell-1/s);
    expect(h).toMatch(/<li class="cut cut-chip rc-tell"[^>]*>(?:(?!<\/li>).)*bomb-tell-2/s);
    expect(TELLS.map((t) => t.name)).toEqual(["Glow", "Hot seams", "White-hot"]);
    expect(readFileSync(new URL("./railcar.css", import.meta.url), "utf8")).toMatch(/\.rc-tell img \{[^}]*grayscale\(1\)/);
  });

  it("the Play tile is the new file name, so the image cache lets go of the old one", () => {
    expect(art.railcarTile).toBe("/art/final/railcar/tile-v2.webp");
  });
});
