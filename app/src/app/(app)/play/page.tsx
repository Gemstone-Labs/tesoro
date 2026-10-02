import { redirect } from "next/navigation";
import { PlayNowRail } from "@/components/lobby/PlayNowRail";

/** Play picks the Game: every live Game as a tile, each opening its detail page. `/play?game=holdem` still deep-links to Hold'em. */
export default async function Play({ searchParams }: PageProps<"/play">) {
  const sp = await searchParams;
  if (sp.game === "holdem") redirect("/play/holdem");
  if (sp.game === "block-puzzle") redirect("/play/block-puzzle");
  if (sp.game === "trading-duel") redirect("/play/trading-duel");
  return (
    <div className="lobby">
      <PlayNowRail />
    </div>
  );
}
