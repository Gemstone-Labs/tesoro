import { EnterMatch } from "@/components/match/EnterMatch";

export default async function QueuePage({ searchParams }: PageProps<"/play/queue">) {
  const sp = await searchParams;
  const entry = [500, 1000, 2500].find((e) => String(e) === sp.entry) ?? 1000;
  const game = sp.game === "holdem" ? "holdem" : "block-puzzle";
  const backing = typeof sp.backing === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sp.backing) ? sp.backing : undefined;
  return <EnterMatch kind="queue" entry={entry} game={game} backing={backing} />;
}
