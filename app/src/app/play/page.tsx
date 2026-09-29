import { Button, Chip, GemaAmount, Label } from "@/components/ui";
import { GAME_NAMES } from "@/lib/mock";
import type { EntrySize, GameId } from "@/lib/mock";
import { BlockPuzzleGame } from "@/games/block-puzzle/BlockPuzzleGame";
import { MatchHistory } from "./MatchHistory";

export default async function Play({ searchParams }: PageProps<"/play">) {
  const sp = await searchParams;
  const game: GameId = sp.game === "holdem" ? "holdem" : "block-puzzle";
  const entry = ([500, 1000, 2500] as const).find((e) => String(e) === sp.entry) ?? (1000 as EntrySize);

  return (
    <div className="cols cols-2">
      <section className="stack" aria-label="Game">
        {game === "block-puzzle" ? (
          <>
            <BlockPuzzleGame />
            <Button href={`/play/queue?entry=${entry}`} variant="money" block>
              Play now — you&apos;ll be paired · {entry.toLocaleString("en-US")} Gemas
            </Button>
          </>
        ) : (
          <>
            <div className="spread">
              <h1 className="page-title">{GAME_NAMES[game]}</h1>
              <Chip tone="money">
                <GemaAmount value={entry} size="sm" /> entry
              </Chip>
            </div>
            <div className="cut cut-frame game-frame">
              <div className="stack">
                <Label>How a Match plays</Label>
                <p className="meta">
                  Heads-up no-limit, 1,500 Chips each, Turbo blinds rising every hand, 30 seconds per action. Play until one
                  Player holds every Chip; the winner takes the Pot minus Fees. Chips are scorekeeping inside the Match, not Gemas.
                </p>
              </div>
            </div>
            <Button href={`/play/queue?game=holdem&entry=${entry}`} variant="money" block>
              Enter a Match · {entry.toLocaleString("en-US")} Gemas
            </Button>
          </>
        )}
      </section>

      <MatchHistory />
    </div>
  );
}
