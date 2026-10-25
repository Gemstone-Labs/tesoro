import { describe, expect, it } from "vitest";
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
