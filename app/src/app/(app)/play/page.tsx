import { redirect } from "next/navigation";
import { isGameId } from "@/lib/games";
import { PlayHome } from "./PlayHome";

/** Home. `/play?game=holdem` still deep-links to a visible Game's page. */
export default async function Play({ searchParams }: PageProps<"/play">) {
  const sp = await searchParams;
  if (isGameId(sp.game)) redirect(`/play/${sp.game}`);
  return <PlayHome />;
}
