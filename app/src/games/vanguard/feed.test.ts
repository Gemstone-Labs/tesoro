import { describe, expect, it } from "vitest";
import { pushFeed } from "./feed";

describe("pushFeed", () => {
  it("puts the newest message first and keeps a few", () => {
    let f: string[] = [];
    for (const m of ["a", "b", "c", "d", "e"]) f = pushFeed(f, m);
    expect(f).toEqual(["e", "d", "c", "b"]);
  });
  it("does not repeat the message already on top", () => {
    expect(pushFeed(["a"], "a")).toEqual(["a"]);
  });
  it("ignores blank messages", () => {
    expect(pushFeed(["a"], "")).toEqual(["a"]);
  });
});
