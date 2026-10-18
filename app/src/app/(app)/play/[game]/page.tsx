import { notFound } from "next/navigation";
import type { GameId } from "@/lib/mock";
import { GamePage } from "./GamePage";

const GAMES: GameId[] = ["block-puzzle", "holdem", "trading-duel", "vanguard"];

/** A Game's detail page: hero with entry picker, your recent Matches, top scores, how to play. */
export default async function GameRoute({ params }: PageProps<"/play/[game]">) {
  const { game } = await params;
  if (!GAMES.includes(game as GameId)) notFound();
  return <GamePage game={game as GameId} />;
}

export function generateStaticParams() {
  return GAMES.map((game) => ({ game }));
}
