import { describe, expect, it } from "vitest";
import { canRematch, opponentFromParam, rematchHref } from "./rematch";

const OPP = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("canRematch", () => {
  it("offers it to a Player after a settled Match with a known opponent", () => {
    for (const outcome of ["won", "lost", "draw"] as const) expect(canRematch({ role: "player", outcome, opponent: OPP })).toBe(true);
  });
  it("hides it for refunds, backers and unknown opponents", () => {
    expect(canRematch({ role: "player", outcome: "refunded", opponent: OPP })).toBe(false);
    expect(canRematch({ role: "backer", outcome: "won", opponent: OPP })).toBe(false);
    expect(canRematch({ role: "player", outcome: "won", opponent: null })).toBe(false);
    expect(canRematch({ role: "player", outcome: "won" })).toBe(false);
    expect(canRematch({ role: "player", outcome: "won", opponent: "nope" })).toBe(false);
  });
});

describe("rematchHref", () => {
  it("carries entry and opponent for Block Burst", () => {
    expect(rematchHref({ game: "block-puzzle", entry: 1000, opponent: OPP })).toBe(`/play/challenge?entry=1000&opponent=${OPP}`);
  });
  it("carries the Game and the Trading Duel asset", () => {
    expect(rematchHref({ game: "holdem", entry: 500, opponent: OPP })).toBe(`/play/challenge?game=holdem&entry=500&opponent=${OPP}`);
    expect(rematchHref({ game: "vanguard", entry: 500, opponent: OPP })).toBe(`/play/challenge?game=vanguard&entry=500&opponent=${OPP}`);
    expect(rematchHref({ game: "trading-duel", asset: 1, entry: 2500, opponent: OPP })).toBe(`/play/challenge?game=trading-duel&asset=eth&entry=2500&opponent=${OPP}`);
  });
});

describe("opponentFromParam", () => {
  it("accepts a wallet address and rejects anything else", () => {
    expect(opponentFromParam(OPP)).toBe(OPP);
    expect(opponentFromParam([OPP, "x"])).toBe(OPP);
    expect(opponentFromParam("<script>")).toBeUndefined();
    expect(opponentFromParam(undefined)).toBeUndefined();
  });
});
