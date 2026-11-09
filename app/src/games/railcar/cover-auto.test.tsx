import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { boardingCountdown, boardingNotAboard, riding, rideStarting, workedResult } from "./fixtures";
import { RailcarScreen } from "./RailcarScreen";

const html = (view: Parameters<typeof RailcarScreen>[0]["view"]) => renderToStaticMarkup(<RailcarScreen view={view} />);

/** What the Railcar screen asks the Arena for: which game's backdrop, and whether to cover the window. */
const seen = vi.hoisted(() => [] as { game: string; autoFull?: boolean }[]);
vi.mock("../fx/Arena", () => ({
  Arena: (p: { game: string; autoFull?: boolean; children: React.ReactNode }) => {
    seen.push({ game: p.game, autoFull: p.autoFull });
    return <>{p.children}</>;
  },
}));

describe("Railcar covers the window from departure until the Result", () => {
  afterEach(() => {
    seen.length = 0;
  });
  const cover = (v: Parameters<typeof RailcarScreen>[0]["view"]) => {
    seen.length = 0;
    html(v);
    return seen;
  };

  it("Boarding stays uncovered: the Player is waiting in the Lobby", () => {
    expect(cover(boardingCountdown())).toEqual([{ game: "railcar", autoFull: false }]);
    expect(cover(boardingNotAboard())).toEqual([{ game: "railcar", autoFull: false }]);
  });

  it("a Player's ride covers from the moment the car leaves, and after their Jump until the Result", () => {
    expect(cover(rideStarting())).toEqual([{ game: "railcar", autoFull: true }]);
    expect(cover(riding())).toEqual([{ game: "railcar", autoFull: true }]);
    expect(cover(riding(undefined, { jumpedMe: true }))).toEqual([{ game: "railcar", autoFull: true }]);
  });

  it("someone watching a ride they are not in keeps the shell (the menu and F still cover it)", () => {
    expect(cover(riding(null))).toEqual([{ game: "railcar", autoFull: false }]);
  });

  it("the Result ends the cover", () => {
    expect(cover(workedResult())).toEqual([]);
  });
});
