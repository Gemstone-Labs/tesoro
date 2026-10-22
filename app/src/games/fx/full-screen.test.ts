import { afterEach, describe, expect, it, vi } from "vitest";

/** A bare document: a class list, plus the browser full-screen calls the game must never make. */
function fakeDocument() {
  const classes = new Set<string>();
  const requestFullscreen = vi.fn();
  const exitFullscreen = vi.fn();
  const doc = {
    documentElement: { classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) }, requestFullscreen, webkitRequestFullscreen: requestFullscreen },
    exitFullscreen,
    webkitExitFullscreen: exitFullscreen,
  };
  vi.stubGlobal("document", doc);
  return { classes, requestFullscreen, exitFullscreen };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("game full screen", () => {
  it("covers the window with the page class only, never the browser's own full screen", async () => {
    const d = fakeDocument();
    const fs = await import("./full-screen");
    fs.setFullScreen(true);
    expect(fs.isFullScreen()).toBe(true);
    expect(d.classes.has("game-full")).toBe(true);
    fs.setFullScreen(false);
    expect(fs.isFullScreen()).toBe(false);
    expect(d.classes.has("game-full")).toBe(false);
    expect(d.requestFullscreen).not.toHaveBeenCalled();
    expect(d.exitFullscreen).not.toHaveBeenCalled();
  });

  it("tells every toggle on the page, once per change", async () => {
    fakeDocument();
    const fs = await import("./full-screen");
    const seen = vi.fn();
    const stop = fs.subscribeFullScreen(seen);
    fs.setFullScreen(true);
    fs.setFullScreen(true);
    fs.setFullScreen(false);
    stop();
    fs.setFullScreen(true);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
