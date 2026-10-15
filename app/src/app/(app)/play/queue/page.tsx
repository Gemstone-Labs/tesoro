import { EnterMatch } from "@/components/match/EnterMatch";
import { ENTRY_SIZES } from "@/lib/cluster-settings";
import { assetFromParam, gameFromParam } from "@/lib/game-params";

export default async function QueuePage({ searchParams }: PageProps<"/play/queue">) {
  const sp = await searchParams;
  const entry = ENTRY_SIZES.find((e) => String(e) === sp.entry) ?? 1000;
  const game = gameFromParam(sp.game);
  const backing = typeof sp.backing === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(sp.backing) ? sp.backing : undefined;
  return <EnterMatch kind="queue" entry={entry} game={game} asset={assetFromParam(sp.asset)} backing={backing} />;
}
