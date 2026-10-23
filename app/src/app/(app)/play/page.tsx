import { redirect } from "next/navigation";
import { PlayHome } from "./PlayHome";

/** Home. `/play?game=holdem` still deep-links to a Game's page. */
export default async function Play({ searchParams }: PageProps<"/play">) {
  const sp = await searchParams;
  if (sp.game === "holdem") redirect("/play/holdem");
  if (sp.game === "block-puzzle") redirect("/play/block-puzzle");
  if (sp.game === "trading-duel") redirect("/play/trading-duel");
  if (sp.game === "vanguard") redirect("/play/vanguard");
  return <PlayHome />;
}
