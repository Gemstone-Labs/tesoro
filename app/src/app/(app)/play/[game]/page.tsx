import { notFound } from "next/navigation";
import { GAME_LIST, isGameId } from "@/lib/games";
import { GamePage } from "./GamePage";

/** A Game's detail page: hero with entry picker, your recent Matches, top scores, how to play. */
export default async function GameRoute({ params }: PageProps<"/play/[game]">) {
  const { game } = await params;
  if (!isGameId(game)) notFound();
  return <GamePage game={game} />;
}

export function generateStaticParams() {
  return GAME_LIST.map((game) => ({ game }));
}
