import { describe, expect, it } from "vitest";
import { enteredHint, rememberEntered } from "./entered-hint";

describe("entered hint", () => {
  it("is known for a Match just opened and absent for any other", () => {
    rememberEntered("a-1", { game: "holdem", entry: 500, challenge: false });
    expect(enteredHint("a-1")).toEqual({ game: "holdem", entry: 500, challenge: false });
    expect(enteredHint("a-2")).toBeNull();
    expect(enteredHint(undefined)).toBeNull();
  });
});
