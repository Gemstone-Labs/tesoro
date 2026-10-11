// Storybook: the leaderboard comes from the story (`parameters.screen.leaderboard`), never from /api/leaderboard.
import type { LeaderboardView } from "../../../../../src/lib/chain/leaderboard-view";
import { leaderboardView, screenData } from "../../../../../stories/screens/support/screen";

export function useLeaderboard(me?: string | null): { data: LeaderboardView | null; error: boolean; retry: () => void } {
  const kind = screenData().leaderboard ?? "live";
  const retry = () => {};
  if (kind === "loading") return { data: null, error: false, retry };
  if (kind === "error") return { data: null, error: true, retry };
  const data = leaderboardView(kind);
  return { data: me ? { ...data, me: data.standings.find((r) => r.account === me) ?? null } : data, error: false, retry };
}
