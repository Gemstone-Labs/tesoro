import { redirect } from "next/navigation";

/** Play is the Game's detail page: `/play` goes to Block Puzzle, `/play?game=holdem` to Hold'em. */
export default async function Play({ searchParams }: PageProps<"/play">) {
  const sp = await searchParams;
  redirect(sp.game === "holdem" ? "/play/holdem" : "/play/block-puzzle");
}
