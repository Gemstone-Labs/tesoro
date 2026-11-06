import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HistoryRow } from "@/lib/chain/history";
import { MatchBanner } from "./MatchBanner";

const ME = "6Nw6KJv8QZ2xYhrfK9tQmGbq9uTq1Yq5h3m7V8aJp4Cn";
const BACKER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const NOW = 1_762_300_000_000;
const ride = (o: Partial<HistoryRow>): HistoryRow => ({ id: "Opener1-7", game: "railcar", entry: 500, role: "player", result: "won", delta: 313, backing: null, scores: null, opp: null, at: NOW - 3_600_000, asset: null, ride: { seated: 5, kind: "place", place: 1, jumpMs: 99_000 }, ...o });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("a Railcar ride in the Matches history", () => {
  it("shows the Player's place, when they jumped and how many rode, and opens the ride", () => {
    const html = renderToStaticMarkup(<MatchBanner r={ride({})} account={ME} me={ME} now={NOW} />);
    expect(text(html)).toContain("Railcar · 1h ago");
    expect(text(html)).toContain("Won");
    expect(text(html)).toContain("Last off at 1:39");
    expect(text(html)).toContain("5 Players");
    expect(text(html)).toContain("+313 Gemas");
    expect(html).toContain('href="/play/railcar/ride/Opener1-7"');
    expect(html).not.toContain("No opponent");
  });

  it("an early Jump, aboard at Impact and a refunded ride each say what happened", () => {
    const line = (r: Partial<HistoryRow>) => text(renderToStaticMarkup(<MatchBanner r={ride(r)} account={ME} me={ME} now={NOW} />));
    expect(line({ result: "lost", delta: -150, ride: { seated: 5, kind: "early", jumpMs: 25_000 } })).toContain("Jumped at 0:25");
    expect(line({ result: "lost", delta: -500, ride: { seated: 5, kind: "aboard" } })).toContain("Aboard at Impact");
    expect(line({ result: "refunded", delta: 0, ride: { seated: 5, kind: "refund" } })).toContain("Entry refunded");
    expect(line({ ride: { seated: 5, kind: "place", place: 3, jumpMs: 95_000 }, delta: 78 })).toContain("Third-last off at 1:35");
  });

  it("a Backer's row: the Player they backed rides, the line says so", () => {
    const html = renderToStaticMarkup(<MatchBanner r={ride({ role: "backer", delta: 78, backing: { other: ME, shareBps: 4_000 } })} account={BACKER} me={BACKER} now={NOW} />);
    expect(text(html)).toContain("You backed 6Nw6…p4Cn");
    expect(text(html)).toContain("+78 Gemas");
  });

  it("a car refunded before its ride was revealed: what paid came back, with no seat, Jump or Player shown as theirs", () => {
    const r = ride({ role: "funder", result: "refunded", delta: 0, ride: { seated: 5, kind: "refund" } });
    const html = renderToStaticMarkup(<MatchBanner r={r} account={BACKER} me={BACKER} now={NOW} />);
    expect(text(html)).toContain("Refunded");
    expect(text(html)).toContain("Car refunded · 500 back to you");
    expect(text(html)).toContain("5 Players");
    expect(text(html)).not.toContain("You ");
    expect(html).not.toContain("mb-you");
    expect(html).not.toContain(" of ");
    expect(html).not.toContain("mb-av-wrap\"><img");
  });
});
