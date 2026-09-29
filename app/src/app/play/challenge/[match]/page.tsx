import { EnterMatch } from "@/components/match/EnterMatch";

/** A Challenge link: opening it joins the Match. */
export default async function JoinChallengePage({ params, searchParams }: PageProps<"/play/challenge/[match]">) {
  const { match } = await params;
  const sp = await searchParams;
  const backing = typeof sp.backing === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sp.backing) ? sp.backing : undefined;
  return <EnterMatch kind="challenge-join" id={/^\d+$/.test(match) ? match : "0"} backing={backing} />;
}
