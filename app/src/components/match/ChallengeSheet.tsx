"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AssetPicker, Button, EntryPicker, GamePicker, Sheet } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { BRAND } from "@/lib/brand";
import { fmtGemas } from "@/lib/format";
import { useFriends } from "@/lib/friends/FriendsProvider";
import { gameQuery } from "@/lib/game-params";
import { GAME_LIST } from "@/lib/games";
import type { EntrySize, GameId } from "@/lib/mock";

/**
 * Game and entry for a Challenge to one Player, then the New Challenge page with them in the other seat.
 * A Friend sees it on their Friends page; anyone else only through the link.
 */
export function ChallengeSheet({ open, onClose, player, name }: { open: boolean; onClose: () => void; player: string; name: string }) {
  const { auth } = useAccount();
  const friend = useFriends().relation(player) === "friend";
  const router = useRouter();
  const [game, setGame] = useState<GameId>("block-puzzle");
  const [entry, setEntry] = useState<EntrySize>(1000);
  const [asset, setAsset] = useState<0 | 1 | 2>(0);
  return (
    <Sheet open={open} onClose={onClose} title={`Challenge ${name}`}>
      <div className="stack-lg">
        <GamePicker games={GAME_LIST} value={game} onChange={setGame} name="cs-game" />
        {game === "trading-duel" && <AssetPicker value={asset} onChange={setAsset} name="cs-asset" />}
        <EntryPicker value={entry} onChange={setEntry} name="cs-entry" />
        <p className="meta">
          {friend
            ? `${name} sees your Challenge on their Friends page. You also get a link to send, and whoever opens it first joins. `
            : `${BRAND.name} cannot tell this Player about your Challenge. You get a link to send them yourself, and whoever opens it first joins. `}
          Your entry goes in the Pot when you open it; if nobody joins, it is refunded.
        </p>
        <Button
          variant="money"
          block
          onClick={() => auth.gate("Challenge a Player", () => router.push(`/play/challenge?${gameQuery(game, asset)}entry=${entry}&opponent=${player}`))}
        >
          Continue · {fmtGemas(entry)} Gemas
        </Button>
      </div>
    </Sheet>
  );
}
