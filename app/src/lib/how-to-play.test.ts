import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CLIP_EXTENSIONS, GUIDE_STEPS, clipPaths } from "./how-to-play";
import { markFirstPracticeGuideShown, shouldShowFirstPracticeGuide } from "./how-to-play-seen";
import type { GameId } from "./mock/types";

const GAMES = Object.keys(GUIDE_STEPS) as GameId[];

function fakeStorage(throws: boolean) {
  const data = new Map<string, string>();
  const fail = () => { throw new Error("blocked"); };
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (k: string) => (throws ? fail() : (data.get(k) ?? null)),
      setItem: (k: string, v: string) => (throws ? fail() : void data.set(k, v)),
    },
  });
}

describe("guide steps", () => {
  it("covers the four Games with five steps each", () => {
    expect(GAMES.sort()).toEqual(["block-puzzle", "holdem", "trading-duel", "vanguard"]);
    for (const g of GAMES) {
      expect(GUIDE_STEPS[g]).toHaveLength(5);
      for (const s of GUIDE_STEPS[g]) expect(s.title && s.line).toBeTruthy();
    }
  });

  it("names clips by Game, step and screen", () => {
    expect(clipPaths("holdem", 3, "phone")).toEqual({
      webm: "/art/how-to-play/holdem/3-phone.webm",
      mp4: "/art/how-to-play/holdem/3-phone.mp4",
      poster: "/art/how-to-play/holdem/3-phone.webp",
    });
  });

  it("has all 6 clip files for every step on disk", () => {
    for (const g of GAMES) {
      for (let n = 1; n <= 5; n++) {
        for (const set of ["phone", "desktop"] as const) {
          const p = clipPaths(g, n, set);
          for (const ext of CLIP_EXTENSIONS) {
            const url = ext === "webp" ? p.poster : p[ext];
            expect(existsSync(join(process.cwd(), "public", url)), url).toBe(true);
          }
        }
      }
    }
  });
});

describe("first Practice guide, shown once per Game per device", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows until marked, then never again, per Game", () => {
    fakeStorage(false);
    expect(shouldShowFirstPracticeGuide("vanguard")).toBe(true);
    markFirstPracticeGuideShown("vanguard");
    expect(shouldShowFirstPracticeGuide("vanguard")).toBe(false);
    expect(shouldShowFirstPracticeGuide("holdem")).toBe(true);
  });

  it("remembers across page loads through storage", () => {
    fakeStorage(false);
    markFirstPracticeGuideShown("trading-duel");
    // a new tab has no in-memory record; reading the stored flag alone must still say seen
    vi.resetModules();
    return import("./how-to-play-seen").then((fresh) => expect(fresh.shouldShowFirstPracticeGuide("trading-duel")).toBe(false));
  });

  it("when storage throws, shows once and then not again in the tab", () => {
    fakeStorage(true);
    expect(shouldShowFirstPracticeGuide("block-puzzle")).toBe(true);
    expect(() => markFirstPracticeGuideShown("block-puzzle")).not.toThrow();
    expect(shouldShowFirstPracticeGuide("block-puzzle")).toBe(false);
  });
});
