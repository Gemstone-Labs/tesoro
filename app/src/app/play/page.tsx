import { Card, Chip, CheckIcon, Label, XIcon, MinusIcon, GemaAmount, ChainChip } from "@/components/ui";
import { GAME_NAMES, matches } from "@/lib/mock";
import type { EntrySize, GameId, MatchResult } from "@/lib/mock";
import { fmtGemas } from "@/lib/format";
import { BlockPuzzleGame } from "@/games/block-puzzle/BlockPuzzleGame";

const RESULT: Record<MatchResult, { text: string; tone: "money" | "danger" | "neutral"; icon: React.ReactNode }> = {
  won: { text: "Won", tone: "money", icon: <CheckIcon /> },
  lost: { text: "Lost", tone: "danger", icon: <XIcon /> },
  draw: { text: "Draw", tone: "neutral", icon: <MinusIcon /> },
  refunded: { text: "Refunded", tone: "neutral", icon: <MinusIcon /> },
};

export default async function Play({ searchParams }: PageProps<"/play">) {
  const sp = await searchParams;
  const game: GameId = sp.game === "holdem" ? "holdem" : "block-puzzle";
  const entry = ([500, 1000, 2500] as const).find((e) => String(e) === sp.entry) ?? (1000 as EntrySize);

  return (
    <div className="cols cols-2">
      <section className="stack" aria-label="Game">
        {game === "block-puzzle" ? (
          <BlockPuzzleGame />
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

      <section className="stack" aria-labelledby="mh">
        <Label><span id="mh">Match history</span></Label>
        {matches.map((m) => {
          const r = RESULT[m.result];
          return (
            <Card key={m.id} as="article" aria-label={`${GAME_NAMES[m.game]} against ${m.opponent}`}>
              <div className="spread">
                <span className="row-body">
                  <span className="row-title">{GAME_NAMES[m.game]} vs {m.opponent}</span>
                  <span className="row-meta">
                    Entry {fmtGemas(m.entry)} · <span className="mono">{m.seed}</span>
                  </span>
                </span>
                <span className="stack" style={{ gap: 4, justifyItems: "end" }}>
                  <Chip tone={r.tone} icon={r.icon}>{r.text}</Chip>
                  <GemaAmount value={m.gemasDelta} size="sm" sign />
                </span>
              </div>
            </Card>
          );
        })}
        <p className="note">Example history. <ChainChip chain="SOL" /> settlement is on Solana devnet.</p>
      </section>
    </div>
  );
}
