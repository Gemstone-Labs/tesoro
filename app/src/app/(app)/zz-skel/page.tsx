"use client";
import { MatchBanner, MatchBannerSkeleton, ResultFilterSkeleton } from "@/components/match/MatchBanner";
import { ResultFilter, GameTabs } from "@/components/match/MatchHistory";
import { RESULTS } from "@/lib/chain/history";
const A = "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ";
const B = "3CypiGeDXGsvjUbpbBXShpQCfkMoQDEzrp1BhGNhNhJU";
const row = { id: "1", game: "block-puzzle", entry: 500, role: "player", result: "won", delta: 440, backing: null, scores: null, opp: B, at: Date.now() - 7_200_000, asset: null } as never;
export default function P() {
  return (
    <div className="mh-page" style={{ padding: 16 }}>
      <div id="sk"><ResultFilterSkeleton /><h2 className="h-section mh-finished-h">Finished</h2><MatchBannerSkeleton count={1} label="x" /></div>
      <div id="ld"><ResultFilter base="/matches" game={null} results={RESULTS} counts={{ won: 4, lost: 0, draw: 0, "no-show": 0, refunded: 4 }} /><h2 className="h-section mh-finished-h">Finished</h2>
        <div className="mb-list"><MatchBanner r={row} account={A} now={Date.now()} me={A} /></div></div>
    </div>
  );
}
