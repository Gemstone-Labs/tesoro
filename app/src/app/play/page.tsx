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
            <div className="cut cut-frame game-frame" role="img" aria-label="Game frame placeholder">
              <div className="stack" style={{ justifyItems: "center" }}>
                <Label>Game frame</Label>
                <p className="meta">
                  {GAME_NAMES[game]} runs here. Both Players play the same Seed; the server&apos;s replay of your inputs
                  is the score.
                </p>
                <span className="mono meta">Seed 0x9f3a…c21e · 01:30</span>
              </div>
            </div>
          </>
        )}
      </section>

      <MatchHistory />
    </div>
  );
}
