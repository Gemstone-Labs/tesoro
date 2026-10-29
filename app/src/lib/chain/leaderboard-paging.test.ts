import { describe, expect, it } from "vitest";
import { pageCount, pageFromParam, pageItems, pageOfRank, pageRows, paramForPage, rankRange } from "./leaderboard-paging";

const ranks = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

describe("Leaderboard paging", () => {
  it("shows ranks 4–10 on page 1, 11–17 on page 2: the podium plus 7, ten Players a page", () => {
    expect(pageRows(ranks(40), 0)).toEqual(ranks(10).slice(3));
    expect(pageRows(ranks(40), 1)[0]).toBe(11);
    expect(pageRows(ranks(40), 1)).toHaveLength(7);
    expect(pageRows(ranks(19), 2)).toEqual([18, 19]);
  });
  it("never puts the podium on a page", () => {
    for (const n of [0, 2, 3, 13, 14, 30]) expect(pageRows(ranks(n), 0).every((r) => r > 3)).toBe(true);
  });
  it("has one page up to rank 10 (no controls) and two from rank 11", () => {
    expect([0, 3, 10].map(pageCount)).toEqual([1, 1, 1]);
    expect([11, 13, 17, 18].map(pageCount)).toEqual([2, 2, 2, 3]);
  });
  it("reads the page from the URL, 1-based, and falls back to the first", () => {
    expect(pageFromParam("2", 3)).toBe(1);
    expect(pageFromParam("9", 3)).toBe(2);
    for (const bad of [null, "", "0", "-1", "x", "1.5"]) expect(pageFromParam(bad, 3)).toBe(0);
  });
  it("writes the page to the URL, none for the first", () => {
    expect(paramForPage(0)).toBeNull();
    expect(paramForPage(1)).toBe("2");
  });
  it("finds the page of a rank", () => {
    expect([2, 3, 4, 10, 11, 17, 18].map(pageOfRank)).toEqual([null, null, 0, 0, 1, 1, 2]);
  });
  it("names the ranks on the page", () => {
    expect(rankRange(0, 40)).toEqual({ from: 4, to: 10 });
    expect(rankRange(1, 13)).toEqual({ from: 11, to: 13 });
    expect(rankRange(2, 19)).toEqual({ from: 18, to: 19 });
  });
  it("draws neighbours with gaps on a long list", () => {
    expect(pageItems(0, 3)).toEqual([0, 1, 2]);
    expect(pageItems(0, 10)).toEqual([0, 1, null, 9]);
    expect(pageItems(5, 10)).toEqual([0, null, 4, 5, 6, null, 9]);
  });
});
