import { describe, expect, it, vi } from "vitest";
import { CATALOGUE } from "./catalogue";
import { GAME_LIST } from "./games";

describe("the Play Now catalogue", () => {
  it.each(GAME_LIST)("%s is a live tile with a Match page, Practice and Challenge behind it", (g) => {
    const entry = CATALOGUE.find((c) => c.game === g);
    expect(entry?.live).toBe(true);
  });
  it("has no Practice-only entries left", () => {
    expect(CATALOGUE.some((c) => "practice" in c)).toBe(false);
  });
});

describe("Railcar in the Play Now catalogue", () => {
  it("is a live tile opening its own page at one entry, only where Railcar is shown", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SHOW_RAILCAR", "1");
    const shown = (await import("./catalogue")).CATALOGUE.find((c) => c.key === "railcar");
    expect(shown).toMatchObject({ live: true, href: "/play/railcar", entries: [500] });
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_SHOW_RAILCAR", "");
    expect((await import("./catalogue")).CATALOGUE.some((c) => c.key === "railcar")).toBe(false);
    vi.unstubAllEnvs();
  });
});
