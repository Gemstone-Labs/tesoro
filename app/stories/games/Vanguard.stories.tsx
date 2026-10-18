import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useEffect, useState, type CSSProperties } from "react";
import { Button } from "@/components/ui";
import { Marker, REVEAL_STYLES, type RevealStyle } from "@/games/vanguard/VanguardBoard";
import { VanguardPractice } from "@/games/vanguard/practice/VanguardPractice";
import type { Game, Rank } from "@/games/vanguard/rules";
import "@/games/vanguard/vanguard.css";

/**
 * Vanguard prototype: blitz Stratego, US Army against the Royal Italian Army. You play the US against
 * a local bot on the real rules (`games/vanguard/rules.ts`). Tap a piece, then a marked square; attack an
 * Italian piece to see the reveal (only when you win or tie), the clash or the landmine.
 */
const meta: Meta<typeof VanguardPractice> = {
  title: "Games/Vanguard",
  component: VanguardPractice,
  parameters: { layout: "fullscreen" },
  args: { seed: 7, instant: false, clock: true, reveal: "fade" },
  argTypes: { reveal: { control: "inline-radio", options: REVEAL_STYLES } },
};
export default meta;
type Story = StoryObj<typeof VanguardPractice>;

const phone = (s: Story): Story => ({ ...s, globals: { viewport: { value: "phone390", isRotated: false } } });

/** The real thing: 3-2-1, then 5-second turns against the bot. */
export const Practice: Story = {};

/** No clock and no countdown, to look around and try moves at leisure. */
export const NoClock: Story = { args: { instant: true, clock: false } };

/** The Dust Storm blows after the first two turns. */
export const DustStorm: Story = { args: { instant: true, clock: false, stormAt: 2 } };

/** A Two-Step Turn banked from the start: use it from your plate. */
export const TwoStepTurn: Story = { args: { instant: true, clock: false, twoStep: 1 } };

/** Move one piece of each army (by rank) onto a square, for a ready-made fight. */
const place = (g: Game, army: "us" | "it", rank: Rank, r: number, c: number): Game => {
  const p = g.pieces.find((x) => x.army === army && x.rank === rank);
  if (!p) return g;
  const clear = g.pieces.filter((x) => !(x.r === r && x.c === c) || x.id === p.id);
  return { ...g, pieces: clear.map((x) => (x.id === p.id ? { ...x, r, c, trail: [`${r},${c}`] } : x)) };
};

/**
 * Pieces already in contact mid-board: your General (9) faces a hidden Italian 7 (attack it: you win,
 * the 7 is flashed as it falls), your Sergeant (4) faces a hidden Italian 8 (attack it: you lose, the 8 stays
 * hidden), your Engineer (3) faces a hidden Landmine (it clears it).
 */
export const Contact: Story = {
  args: {
    instant: true,
    clock: false,
    prepare: (g) => {
      let x = g;
      x = place(x, "us", "9", 6, 0);
      x = place(x, "it", "7", 5, 0);
      x = place(x, "us", "4", 6, 4);
      x = place(x, "it", "8", 5, 4);
      x = place(x, "us", "3", 6, 9);
      x = place(x, "it", "B", 5, 9);
      return x;
    },
  },
};

const ABOUT: Record<RevealStyle, string> = {
  fade: "The brass cover fades away, the rim glows.",
  lid: "The brass cover lifts off and away.",
  wipe: "A streak of light sweeps the cover off.",
  dust: "A puff of dust, and the face is there when it clears.",
  stamp: "The piece presses down, the face pops in with a ring flash.",
};

/** The five reveals side by side on big pieces, replaying every few seconds (or on the button). */
function RevealDemo({ size }: { size: number }) {
  const [up, setUp] = useState(false);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const a = setTimeout(() => setUp(true), 700);
    const b = setTimeout(() => setUp(false), 2600);
    const c = setTimeout(() => setRound((r) => r + 1), 3200);
    return () => [a, b, c].forEach(clearTimeout);
  }, [round]);
  const ranks: Rank[] = ["7", "3", "10", "B", "2"];
  return (
    <div className="vg-reveal-demo">
      <div>
        <Button onClick={() => setRound((r) => r + 1)}>Reveal again</Button>
      </div>
      <div className="vg-reveal-row">
        {REVEAL_STYLES.map((st, i) => (
          <div key={st} className="vg-reveal-cell" style={{ "--vg-sq": `${size}px` } as CSSProperties}>
            <div className="vg-slot">
              <Marker p={{ id: i, army: "it", rank: ranks[i], r: 0, c: 0, up }} selected={false} onTap={() => {}} disabled reveal={st} />
            </div>
            <b>{st}</b>
            <small>{ABOUT[st]}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Pick a reveal: all five at once, at a big size and at phone size. Then try it in context with Contact. */
export const RevealStyles: StoryObj = {
  render: () => (
    <>
      <RevealDemo size={120} />
      <RevealDemo size={36} />
    </>
  ),
};

export const PhonePractice = phone({ args: { instant: true, clock: true } });
export const PhoneNoClock = phone({ args: { instant: true, clock: false } });
