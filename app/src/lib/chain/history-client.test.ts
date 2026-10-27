import { describe, expect, it } from "vitest";
import { fetchAllHistory, fetchHistoryPage } from "./history-client";

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
