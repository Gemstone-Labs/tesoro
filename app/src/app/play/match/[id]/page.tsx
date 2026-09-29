import { MatchRoute } from "@/components/match/MatchRoute";

export default async function MatchPage({ params }: PageProps<"/play/match/[id]">) {
  const { id } = await params;
  return <MatchRoute matchId={id} />;
}
