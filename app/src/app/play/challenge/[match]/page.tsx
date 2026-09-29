import { EnterMatch } from "@/components/match/EnterMatch";

/** A Challenge link: opening it joins the Match. */
export default async function JoinChallengePage({ params }: PageProps<"/play/challenge/[match]">) {
  const { match } = await params;
  return <EnterMatch kind="challenge-join" id={/^\d+$/.test(match) ? match : "0"} />;
}
