import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { NO_CARD, PHASE, SPLIT, STATUS, call, check, raise, type Action } from "@/games/holdem/chain";
import { HoldemTable } from "@/games/holdem/HoldemTable";
import { PlayingCard } from "@/games/holdem/cards";
import { HandLogView, type LogPlayer } from "@/games/holdem/HandLogView";
import type { HandLog, LogStreet } from "@/games/holdem/handlog";
import { art } from "@/lib/art";
import { HoldemPractice } from "@/games/holdem/practice/HoldemPractice";
import { act, deal, newPractice, type Practice } from "@/games/holdem/practice/engine";
import "@/games/holdem/holdem.css";

const NOW = 1_800_000_000;
const noop = () => undefined;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A practice hand played through `steps` (seat, action) pairs on a seeded deck. */
function hand(seed: number, steps: [number, Action][]): Practice {
  const r = rng(seed);
  let p = deal(newPractice(NOW, r), NOW, r);
  for (const [seat, a] of steps) p = act(p, seat, a, NOW, r);
  return p;
}

const checkDown: [number, Action][] = [
  [0, call()],
  [1, check()],
  [1, check()],
  [0, check()],
  [1, check()],
  [0, check()],
  [1, check()],
  [0, check()],
];
const allIn: [number, Action][] = [
  [0, raise(1500)],
  [1, call()],
];

/** The first seed whose hand ends the way `want` says (hand 1, seat 0 is you). */
function seedFor(steps: [number, Action][], want: (p: Practice) => boolean): number {
  for (let s = 1; s < 400; s++) {
    try {
      if (want(hand(s, steps))) return s;
    } catch {
      // not a legal line on this deck
    }
  }
  return 1;
}

const wonShowdown = (p: Practice) => p.table.lastHand.showdown && p.table.lastHand.result === 0;
const lostShowdown = (p: Practice) => p.table.lastHand.showdown && p.table.lastHand.result === 1;

function Table({ p }: { p: Practice }) {
  const t = p.table;
  const playing = t.phase >= PHASE.preflop && t.phase <= PHASE.river;
  const ended = t.status === STATUS.over;
  const hole = p.lastHoles ? { handNo: playing ? t.handNo : t.lastHand.handNo, cards: p.lastHoles[0] } : null;
  return <HoldemTable table={t} seat={0} hole={hole} busy={null} ended={ended} onAct={noop} onClaim={noop} practice />;
}

const meta = {
  title: "Games/Hold'em",
  parameters: { layout: "padded", shell: "app" },
} satisfies Meta;
export default meta;

const story = (build: () => Practice): StoryObj => ({ render: () => <Table p={build()} /> });

/** Hand 1, you are the small blind and must act on the big blind. */
export const Preflop = story(() => hand(5, []));
/** Preflop done, on the flop it is your turn with no bet to face. */
export const Flop = story(() => hand(5, [[0, call()], [1, check()], [1, check()]]));
/** The opponent bets 300 into the flop and it is on you. */
export const FacingABet = story(() => hand(5, [[0, call()], [1, check()], [1, raise(300)]]));
export const Turn = story(() => hand(5, checkDown.slice(0, 5)));
export const River = story(() => hand(5, checkDown.slice(0, 7)));
/** The river is checked down and you win the pot. The next hand waits to be dealt. */
export const ShowdownWon = story(() => hand(seedFor(checkDown, wonShowdown), checkDown));
export const ShowdownLost = story(() => hand(seedFor(checkDown, lostShowdown), checkDown));
/** All in before the flop: the Match is over and you won. */
export const MatchEndedWon = story(() => hand(seedFor(allIn, (p) => p.table.status === STATUS.over && p.table.winner === 0), allIn));
export const MatchEndedLost = story(() => hand(seedFor(allIn, (p) => p.table.status === STATUS.over && p.table.winner === 1), allIn));

/** The real practice game against the local bot. */
export const PlayPractice: StoryObj = { render: () => <HoldemPractice /> };

/* ——— Cards ——— */

const SUITS = ["Clubs", "Diamonds", "Hearts", "Spades"];

export const CardGallery: StoryObj = {
  render: () => (
    <div className="sbm" style={{ display: "grid", gap: 24 }}>
      {(["md", "lg"] as const).map((size) => (
        <section key={size} className="sbm-panel" style={{ display: "grid", gap: 12, padding: 16 }}>
          <h3>Size {size}</h3>
          {SUITS.map((name, s) => (
            <div key={name} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span className="meta" style={{ width: 70 }}>{name}</span>
              {Array.from({ length: 13 }, (_, r) => (
                <PlayingCard key={r} card={s * 13 + r} size={size} />
              ))}
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="meta" style={{ width: 70 }}>Other</span>
            <PlayingCard back size={size} />
            <PlayingCard card={NO_CARD} size={size} />
            <span className="meta">back, empty slot</span>
          </div>
        </section>
      ))}
    </div>
  ),
};

// Board: As Kd 7h 2c 9s; you hold Ah Qc, the opponent Ks Jd.
const LOG_BOARD = [12 + 39, 11 + 13, 5 + 26, 0, 7 + 39];
const LOG_PLAYERS: [LogPlayer, LogPlayer] = [{ picture: art.avatars[2], label: "You" }, { picture: art.avatars[6], label: "Bot" }];
const logOf = (done: boolean): HandLog => ({
  hand: 7,
  done,
  prev: null,
  past: [],
  end: done ? { handNo: 7, result: 0, pot: 1640n, showdown: true, shown: [[12 + 26, 10], [11 + 39, 9 + 13]], board: LOG_BOARD } : null,
  streets: [
    { name: "Pre-flop", rows: [{ who: "you", act: "small-blind", amount: 10n }, { who: "opponent", act: "big-blind", amount: 20n }, { who: "you", act: "raise", amount: 60n }, { who: "opponent", act: "call", amount: 40n }] },
    { name: "Flop", rows: [{ who: "board", act: "board", cards: LOG_BOARD.slice(0, 3) }, { who: "opponent", act: "check" }, { who: "you", act: "bet", amount: 80n }, { who: "opponent", act: "call", amount: 80n }] },
    { name: "Turn", rows: [{ who: "board", act: "board", cards: [LOG_BOARD[3]] }, { who: "opponent", act: "check" }, { who: "you", act: "check" }] },
    ...(done
      ? [{ name: "River", rows: [{ who: "board", act: "board", cards: [LOG_BOARD[4]] }, { who: "opponent", act: "bet", amount: 680n, allIn: true }, { who: "you", act: "call", amount: 680n }, { who: "both", act: "showdown" }] } satisfies LogStreet]
      : []),
  ],
});
const LOG_HOLES = { 5: [3, 3 + 13], 6: [8 + 39, 8 + 26], 7: [12 + 26, 10], 8: [1 + 13, 6] };
const LogSheet = ({ log }: { log: HandLog }) => (
  <div className="sbm" style={{ maxWidth: 520 }}>
    <div className="hdx-log-body">
      <HandLogView log={log} seat={0} players={LOG_PLAYERS} holes={LOG_HOLES} />
    </div>
  </div>
);
/** Hand 8 in play, with hand 7's showdown, a fold in hand 6 and a split in hand 5 kept below it. */
const withPast = (): HandLog => {
  const seven = logOf(true);
  const preflop = (last: LogStreet["rows"]): LogStreet => ({ name: "Pre-flop", rows: [{ who: "opponent", act: "small-blind", amount: 10n }, { who: "you", act: "big-blind", amount: 20n }, ...last] });
  return {
    hand: 8,
    done: false,
    prev: null,
    end: null,
    streets: [{ name: "Pre-flop", rows: [{ who: "opponent", act: "small-blind", amount: 10n }, { who: "you", act: "big-blind", amount: 20n }, { who: "opponent", act: "raise", amount: 60n }] }],
    past: [
      { hand: 7, streets: seven.streets, end: seven.end },
      { hand: 6, streets: [preflop([{ who: "opponent", act: "raise", amount: 60n }, { who: "you", act: "fold" }])], end: { handNo: 6, result: 1, pot: 80n, showdown: false, shown: [[NO_CARD, NO_CARD], [NO_CARD, NO_CARD]], board: [NO_CARD, NO_CARD, NO_CARD, NO_CARD, NO_CARD] } },
      { hand: 5, streets: [preflop([{ who: "opponent", act: "call", amount: 10n }, { who: "you", act: "check" }])], end: { handNo: 5, result: SPLIT, pot: 40n, showdown: true, shown: [[3, 3 + 13], [3 + 26, 3 + 39]], board: LOG_BOARD } },
    ],
  };
};
export const HandLogPlaying: StoryObj = { render: () => <LogSheet log={logOf(false)} /> };
export const HandLogShowdown: StoryObj = { render: () => <LogSheet log={logOf(true)} /> };
export const HandLogEarlierHands: StoryObj = { render: () => <LogSheet log={withPast()} /> };
