import { describe, expect, it } from "vitest";
import { fetchAllHistory, fetchHistoryPage, fetchRidePage } from "./history-client";

const row = (id: string, scores: unknown) => ({ id, game: "block-puzzle", scores });
const answer = (rows: unknown[]) => (async () => ({ ok: true, json: async () => ({ rows, page: 1, pages: 1, total: rows.length }) })) as unknown as typeof fetch;

describe("history rows with a pair of nulls for scores", () => {
  it("fetchHistoryPage reads them as no scores", async () => {
    const page = await fetchHistoryPage("acc", 1, null, answer([row("a", [null, null]), row("b", [5, 2])]));
    expect(page!.rows.map((r) => r.scores)).toEqual([null, [5, 2]]);
  });
  it("fetchAllHistory reads them as no scores", async () => {
    const rows = await fetchAllHistory("acc", answer([row("a", [null, null])]));
    expect(rows![0].scores).toBeNull();
  });
});

describe("a ride's page from the history route", () => {
  const page = (body: unknown) => (async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
  it("a car refunded before its ride was revealed is a refunded page with no ride", async () => {
    expect(await fetchRidePage("o-7", page({ id: "o-7", entry: 500, game: "railcar", status: "refunded" }))).toEqual({ id: "o-7", entry: 500, ride: null, refunded: true });
  });
  it("a Railcar Match that is not finished, or another Game's, is no ride", async () => {
    expect(await fetchRidePage("o-8", page({ id: "o-8", entry: 500, game: "railcar", status: "settling" }))).toBeNull();
    expect(await fetchRidePage("o-9", page({ id: "o-9", entry: 500, game: "holdem", status: "refunded" }))).toBeNull();
  });
});
