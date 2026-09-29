import { EnterMatch } from "@/components/match/EnterMatch";

export default async function QueuePage({ searchParams }: PageProps<"/play/queue">) {
  const sp = await searchParams;
  const entry = [500, 1000, 2500].find((e) => String(e) === sp.entry) ?? 1000;
  const game = sp.game === "holdem" ? "holdem" : "block-puzzle";
  return <EnterMatch kind="queue" entry={entry} game={game} />;
}
