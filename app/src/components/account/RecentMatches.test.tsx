import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RecentMatches } from "./RecentMatches";
import type { PlayedRow } from "@/lib/chain/player-account";

vi.mock("@/components/account/Player", () => ({ PlayerAvatar: () => <i />, usePlayerLabel: () => "Ben" }));
vi.mock("next/image", () => ({ default: () => <span /> }));

const NOW = 1_000_000_000;
const row = (id: string, delta: number, agoSecs: number, opp: string | null): PlayedRow => ({ id, game: "block-puzzle", result: delta < 0 ? "lost" : "won", delta, at: NOW - agoSecs, opp, match: id }) as unknown as PlayedRow;

describe("Recent Matches rows", () => {
  it("every row has the same cells in the same order, whatever the amount, time or opponent", () => {
    const html = renderToStaticMarkup(<RecentMatches now={NOW * 1000} rows={[row("a", -100, 31 * 60, "x"), row("b", 12345, 6 * 3600, "y"), row("c", 0, 2 * 86400, null)]} />);
    const rows = html.split('class="pa-recent-row"').slice(1);
    expect(rows).toHaveLength(3);
    const cells = (h: string) => [...h.matchAll(/class="([^"]*pa-(?:res|recent-game|recent-who|recent-opp|recent-delta)[^"]*)"|<time/g)].map((m) => (m[1] ?? "time").split(" ").find((c) => c.startsWith("pa-recent-") || c === "pa-res" || c === "time"));
    const shape = cells(rows[0].split("</a>")[0]);
    expect(shape).toEqual(["pa-res", "pa-recent-who", "pa-recent-opp", "pa-recent-delta", "time"]);
    for (const r of rows) expect(cells(r.split("</a>")[0])).toEqual(shape);
  });
});
