import { BlockPuzzleGame } from "@/games/block-puzzle/BlockPuzzleGame";
import { HoldemPractice } from "@/games/holdem/practice/HoldemPractice";

/** Practice, nothing staked: Block Puzzle with a random Seed, or `?game=holdem` for Hold'em against a local bot. */
export default async function Practice({ searchParams }: PageProps<"/play/practice">) {
  const { game } = await searchParams;
  return game === "holdem" ? <HoldemPractice /> : <BlockPuzzleGame />;
}
