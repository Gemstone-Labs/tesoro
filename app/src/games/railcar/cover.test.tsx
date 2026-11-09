import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { boardingCountdown, boardingNotAboard, riding, rideStarting, workedResult } from "./fixtures";
import { RailcarScreen } from "./RailcarScreen";

const html = (view: Parameters<typeof RailcarScreen>[0]["view"]) => renderToStaticMarkup(<RailcarScreen view={view} />);

describe("Railcar full screen: the window cover, never the browser's own", () => {
  it("the ⋯ menu's Full screen has the Railcar screen to cover, in Boarding and during the ride", () => {
    // `html.game-full .fx-arena` is what turns the menu's Full screen (and F) into the window cover.
    const css = readFileSync(new URL("../fx/fx.css", import.meta.url), "utf8");
    expect(css).toMatch(/html\.game-full \.fx-arena \{ position: fixed; inset: 0;/);
    for (const v of [boardingNotAboard(), boardingCountdown(), rideStarting(), riding()]) {
      const h = html(v);
      expect(h).toMatch(/<div class="fx-arena[^"]*" data-game="railcar"[^>]*>.*<section class="rc /s);
      expect(h).toContain("Railcar");
    }
  });

  it("the Result sits in the app shell, outside the cover", () => {
    expect(html(workedResult())).not.toContain("fx-arena");
  });
});
