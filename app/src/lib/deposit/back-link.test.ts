import { describe, expect, it } from "vitest";
import { backLink } from "./back-link";

describe("back to the game", () => {
  it("is nothing without a game", () => {
    expect(backLink(null)).toBeNull();
  });
  it("goes into the Queue at the entry the Player was short for", () => {
    expect(backLink({ game: "holdem", need: 500 })).toEqual({ href: "/play/queue?game=holdem&entry=500", label: "Play Buckshot Hold'em", need: 500 });
  });
  it("opens the game when no entry was asked for", () => {
    expect(backLink({ game: "block-puzzle" })?.href).toBe("/play/block-puzzle");
  });
});
