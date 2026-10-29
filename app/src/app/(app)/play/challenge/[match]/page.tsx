import { EnterMatch } from "@/components/match/EnterMatch";

/** A Challenge link: opening it joins the Match. The join reads the Match by its key and says so when the segment names none. */
export default async function JoinChallengePage({ params, searchParams }: PageProps<"/play/challenge/[match]">) {
  const { match } = await params;
  const sp = await searchParams;
  const backing = typeof sp.backing === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sp.backing) ? sp.backing : undefined;
  return <EnterMatch kind="challenge-join" id={match} backing={backing} />;
}
