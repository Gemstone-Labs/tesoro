import { describe, expect, it } from "vitest";
import { parseRoles, roleTags } from "./waitlist-role";
import { gemFor, parseSpotSlug, shareText, spotPath } from "./waitlist-spot";

describe("waitlist roles", () => {
  it("parses a comma list in a fixed order and drops unknown words", () => {
    expect(parseRoles("studio,player")).toEqual(["player", "studio"]);
    expect(parseRoles(" staker , admin,")).toEqual(["staker"]);
    expect(parseRoles("")).toEqual([]);
    expect(parseRoles(null)).toEqual([]);
  });
  it("names the tags printed on the card", () => expect(roleTags(["player", "staker"])).toEqual(["Player", "Staker"]));
});

describe("shared spot links", () => {
  it("carries the roles and reads them back", () => {
    expect(spotPath(142)).toBe("/spot/142");
    expect(spotPath(142, ["player", "staker"])).toBe("/spot/142-player-staker");
    expect(parseSpotSlug("142")).toEqual({ spot: 142, roles: [] });
    expect(parseSpotSlug("142-player-staker")).toEqual({ spot: 142, roles: ["player", "staker"] });
  });
  it("refuses unknown or repeated roles and bad spots", () => {
    for (const bad of ["142-admin", "142-player-player", "142-", "abc-player", "0", "142-player-"]) expect(parseSpotSlug(bad)).toBeNull();
  });
  it("puts the share link on its own line", () => {
    const gem = gemFor(6);
    expect(shareText(gem, "https://x.y/spot/6")).toBe(
      `I'm #6 on the @PlayTesoro waitlist and pulled the ${gem.name}! What's yours?\n\nOpen your pack: https://x.y/spot/6`,
    );
  });
});
