import { MatchView } from "@/components/match/MatchView";

export default async function MatchPage({ params }: PageProps<"/play/match/[id]">) {
  const { id } = await params;
  return <MatchView matchId={id} />;
}
