import { EnterMatch } from "@/components/match/EnterMatch";

export default async function NewChallengePage({ searchParams }: PageProps<"/play/challenge">) {
  const sp = await searchParams;
  const entry = [500, 1000, 2500].find((e) => String(e) === sp.entry) ?? 1000;
  const game = sp.game === "holdem" ? "holdem" : "block-puzzle";
  const backing = typeof sp.backing === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sp.backing) ? sp.backing : undefined;
  return <EnterMatch kind="challenge-new" entry={entry} game={game} backing={backing} />;
}
