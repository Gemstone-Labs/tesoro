import type { Metadata } from "next";
import { Leaderboard } from "@/components/leaderboard/Leaderboard";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: `Leaderboard · ${BRAND.name}` };

export default function LeaderboardPage() {
  return <Leaderboard />;
}
