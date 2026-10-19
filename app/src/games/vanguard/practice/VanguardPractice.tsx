"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button, Label } from "@/components/ui";
import { art } from "@/lib/art";
import { Arena, Callout, Countdown, FullScreenToggle, MuteToggle, prefersReducedMotion, sfx, type CalloutTone } from "../../fx";
import { CAP_MS, NAMES, ROSTER, TURN_MS, move, newGame, seeded, startTwoStep, targets, timeout, type Depot, type Game, type GameEvent, type Refusal, type Result, type Rng, type Square } from "../rules";
import { VanguardScreen, type TurnInfo } from "../VanguardScreen";
import { VanguardBoard, type HitSide, type ShownFx, type ShownPiece, type ShownStorm } from "../VanguardBoard";
import { botMove } from "./bot";
import "../vanguard.css";

export interface VanguardPracticeProps {
  /** Fixed setup and bot (stories, tests). */
  seed?: number;
  /** Skip the 3-2-1 countdown. */
  instant?: boolean;
  /** Turn clock on (the real 5 seconds); off for a calm look around. */
  clock?: boolean;
  /** Blow the Dust Storm on this turn instead of a random one. */
  stormAt?: number;
  /** Start with Two-Step Turns banked (to try one without raiding first). */
  twoStep?: number;
  /** Change the opening position (stories: put pieces in contact). */
  prepare?: (g: Game) => Game;
}

const REFUSAL_LINE: Record<Refusal, string> = {
  match_over: "The Match is over.",
  cap_passed: "Time is up: the Match is over.",
  turn_expired: "Too late: your time ran out.",
  turn_not_expired: "",
  not_your_turn: "It is not your turn.",
  no_such_piece: "That piece is gone.",
  illegal_move: "That piece can't go there.",
  no_two_step: "You have no Two-Step Turn to spend.",
};

const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, prefersReducedMotion() ? 0 : ms));
const slideMs = (a: Square, b: Square) => Math.min(380, 140 + (Math.abs(a.r - b.r) + Math.abs(a.c - b.c)) * 40);

/** What the US Player sees: own faces always, Italian faces only once known. */
function shownFrom(g: Game): ShownPiece[] {
  return g.pieces.map((p) => ({ id: p.id, army: p.army, rank: p.rank, r: p.r, c: p.c, up: p.army === "us" || p.known }));
}

const END_LINE = {
  truck: { us: "You captured Italy's Supply Truck.", it: "Italy captured your Supply Truck." },
  stuck: { us: "Italy has no piece left that can move.", it: "You have no piece left that can move." },
  timeouts: { us: "Italy let the clock run out three turns in a row.", it: "Your clock ran out three turns in a row." },
  cap: { us: "Move limit reached: your surviving ranks add up higher.", it: "Move limit reached: Italy's surviving ranks add up higher." },
} as const;

/**
 * Vanguard practice: you play the US against a local bot, on the real rules (rules.ts) with the 5-second
 * turn clock. Nothing is staked, there is no wallet and no chain.
 */
export function VanguardPractice(props: VanguardPracticeProps) {
  // The setup and the bot are drawn at random: the server renders no board, so what the browser draws cannot mismatch it.
  const inBrowser = useSyncExternalStore(
    () => () => undefined,
    () => true,
    () => false,
  );
  return inBrowser ? <PracticeMatch {...props} /> : null;
}

function PracticeMatch({ seed, instant = false, clock = true, stormAt, twoStep = 0, prepare }: VanguardPracticeProps) {
  // one random source per mount: seeded in stories, so the setup and the bot repeat
  const [rng] = useState<Rng>(() => (seed === undefined ? Math.random : seeded(seed)));
  const fresh = useCallback(() => {
    const g = newGame(rng, Date.now());
    const ready = { ...g, stormAt: stormAt ?? g.stormAt, twoStep: { us: twoStep, it: 0 } };
    return prepare ? prepare(ready) : ready;
  }, [rng, stormAt, twoStep, prepare]);
  const [game, setGame] = useState<Game>(fresh);
  const gameRef = useRef(game);
  const [pieces, setPieces] = useState<ShownPiece[]>(() => shownFrom(game));
  const [depots, setDepots] = useState<Depot[]>(game.depots);
  const [fx, setFx] = useState<ShownFx[]>([]);
  const [storm, setStorm] = useState<ShownStorm | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [say, setSay] = useState("Your pieces are face up at the bottom. Tap one, then a marked square.");
  const [started, setStarted] = useState(instant);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const fxKey = useRef(1);
  const [call, setCall] = useState<{ key: number; text: string; tone: CalloutTone } | null>(null);
  const shout = useCallback((text: string, tone: CalloutTone = "plain") => setCall({ key: fxKey.current++, text, tone }), []);

  const commit = useCallback((g: Game) => {
    gameRef.current = g;
    setGame(g);
  }, []);
  /** The time an action is stamped with: the real clock, or a fixed instant when the clock is off. */
  const stamp = useCallback((g: Game) => (clock ? Date.now() : g.startedAt), [clock]);
  /** Give the side to act a full turn from now (the screen shows the countdown from when it sees the turn begin). */
  const freshClock = useCallback((g: Game): Game => (clock ? { ...g, deadline: Date.now() + TURN_MS } : g), [clock]);
  const patch = useCallback((id: number, p: Partial<ShownPiece>) => setPieces((ps) => ps.map((x) => (x.id === id ? { ...x, ...p } : x))), []);
  const addFx = useCallback((kind: ShownFx["kind"], r: number, c: number, size: number) => {
    const key = fxKey.current++;
    setFx((f) => [...f, { key, kind, r, c, size }]);
    setTimeout(() => setFx((f) => f.filter((x) => x.key !== key)), 800);
  }, []);

  /** Play what happened, one beat at a time, then show the settled game. */
  const animate = useCallback(async (events: GameEvent[], g: Game) => {
    setBusy(true);
    setSelected(null);
    const before = gameRef.current;
    const name = (id: number) => before.pieces.find((p) => p.id === id);
    let line = "";
    for (const e of events) {
      if (e.kind === "move") {
        const ms = slideMs(e.from, e.to);
        patch(e.id, { r: e.to.r, c: e.to.c, ms });
        sfx("knock");
        await wait(ms);
        if (name(e.id)?.army === "it") line = "Italy moved.";
      } else if (e.kind === "attack") {
        const a = name(e.att)!;
        const d = name(e.def)!;
        const dr = Math.sign(e.to.r - e.from.r);
        const dc = Math.sign(e.to.c - e.from.c);
        const edge = { r: e.to.r - dr * 0.55, c: e.to.c - dc * 0.55 };
        patch(e.att, { r: edge.r, c: edge.c, ms: slideMs(e.from, edge) });
        await wait(slideMs(e.from, edge));
        // the beaten piece's face is flashed to the winner; from the US side that means Italian pieces only
        const flashIt = e.flash.filter((id) => name(id)?.army === "it");
        if (flashIt.length) {
          // the defender was hit on the side facing the attacker; the attacker on its leading side
          const toward: HitSide = dc > 0 ? "left" : dc < 0 ? "right" : dr > 0 ? "top" : "bottom";
          const away: HitSide = ({ left: "right", right: "left", top: "bottom", bottom: "top" } as const)[toward];
          flashIt.forEach((id) => patch(id, { up: true, hitFrom: id === e.def ? toward : away }));
          sfx("flip");
          await wait(820); // long enough to read the face before it falls
        }
        const mid = { r: (edge.r + e.to.r) / 2 + 0.5, c: (edge.c + e.to.c) / 2 + 0.5 };
        if (e.outcome === "mine") addFx("mine", e.to.r + 0.5, e.to.c + 0.5, 2.6);
        else addFx("clash", mid.r, mid.c, 1.9);
        sfx(e.outcome === "mine" ? "blast" : "clash");
        await wait(200);
        const attWins = e.outcome === "win" || e.outcome === "defuse" || e.outcome === "truck";
        const gone = e.outcome === "tie" ? [e.att, e.def] : attWins ? [e.def] : [e.att];
        gone.forEach((id) => patch(id, { gone: true }));
        await wait(300);
        if (attWins) {
          patch(e.att, { r: e.to.r, c: e.to.c, ms: 160 });
          await wait(160);
        }
        const mine = a.army === "us";
        line =
          e.outcome === "truck" ? (mine ? "Supply Truck captured!" : "Italy reached your Supply Truck.")
          : e.outcome === "mine" ? (mine ? `Landmine! Your ${NAMES[a.rank]} is lost, and the mine is now in plain sight. Only an Engineer (3) clears mines.` : "Italy hit one of your Landmines. It is in plain sight now.")
          : e.outcome === "defuse" ? (mine ? "Your Engineer cleared a Landmine." : "An Italian Engineer cleared your Landmine.")
          : e.outcome === "tie" ? `Both ${NAMES[a.rank]}s fall.`
          : mine ? (attWins ? `Your ${a.rank} beat their ${d.rank}.` : `Your ${a.rank} lost. The piece that beat it stays hidden.`)
          : attWins ? `Italy took your ${d.rank} with a hidden piece.` : `Your ${d.rank} held: it beat their ${a.rank}.`;
      } else if (e.kind === "spotted") {
        const p = name(e.id) ?? g.pieces.find((x) => x.id === e.id)!;
        patch(e.id, { up: true, hitFrom: "bottom" });
        addFx("spotted", p.r + 0.5, p.c + 0.5, 2.8);
        sfx("fold");
        shout(p.army === "us" ? "Your Truck is Spotted!" : "Spotted!", "warn");
        line = p.army === "us" ? "Your Supply Truck is out of fuel: Spotted, face up and stuck." : "Italy's Supply Truck is Spotted: face up and out of fuel.";
        await wait(500);
      } else if (e.kind === "raid") {
        setDepots((ds) => ds.map((d) => (d.r === e.at.r && d.c === e.at.c ? { ...d, claimed: true } : d)));
        addFx("spotted", e.at.r + 0.5, e.at.c + 0.5, 1.7);
        sfx("check");
        shout(e.army === "us" ? "Two-Step Turn earned" : "Italy raided your depot");
        line = e.army === "us" ? "Depot raided: you earned a Two-Step Turn. On your turn press “Use Two-Step Turn” to move twice." : "Italy raided your depot and earned a Two-Step Turn.";
        await wait(500);
      } else if (e.kind === "storm") {
        setStorm({ key: Date.now(), axis: e.axis, index: e.index, dir: e.dir });
        sfx("wind");
        shout("Dust storm!", "warn");
        setSay(`Dust storm over ${e.axis === "row" ? `row ${10 - e.index}` : `column ${e.index + 1}`}!`);
        await wait(1500);
        e.shifts.forEach((s) => patch(s.id, { r: s.to.r, c: s.to.c, ms: 420 }));
        await wait(2000);
        setStorm(null);
        line = `The storm drifted ${e.shifts.length} ${e.shifts.length === 1 ? "piece" : "pieces"} one square. Check where yours went.`;
      } else if (e.kind === "turn" && e.timedOut) {
        line = e.turn === "us" ? "Italy ran out of time." : "Time! Your turn passed.";
      }
    }
    setPieces(shownFrom(g));
    setDepots(g.depots);
    commit(freshClock(g));
    if (g.winner) {
      sfx(g.winner === "us" ? "win" : "lose");
    } else if (line) setSay(line);
    // every move gets a fresh 5 seconds, each step of a Two-Step Turn included (founder 2026-10-19)
    setBusy(false);
  }, [addFx, commit, freshClock, patch, shout]);

  /** Play an accepted action; say why a refused one was. */
  const apply = useCallback((r: Result) => {
    if (!r.ok) {
      if (REFUSAL_LINE[r.reason]) setSay(REFUSAL_LINE[r.reason]);
      return;
    }
    if (r.events.length) void animate(r.events, r.game);
    else commit(r.game);
  }, [animate, commit]);

  // the clock: Italy thinks for a beat, then moves; your turn times out after 5 seconds
  useEffect(() => {
    if (!started || busy || game.winner) return;
    if (game.turn === "it") {
      const id = setTimeout(() => {
        let g = gameRef.current;
        const m = botMove(g, rng);
        if (!m) return apply(timeout(g, Math.max(stamp(g), g.deadline + 1)));
        if (m.twoStep) {
          const s = startTwoStep(g, stamp(g));
          if (s.ok) g = s.game;
        }
        apply(move(g, { id: m.id, to: m.to, at: stamp(g) }));
      }, game.movedThisTurn.length ? 350 : 700 + Math.random() * 600);
      return () => clearTimeout(id);
    }
    if (!clock) return;
    // fires just past the turn deadline, or past the time cap if that comes first
    const fireAt = Math.min(game.deadline, game.startedAt + CAP_MS) + 1;
    const id = setTimeout(() => apply(timeout(gameRef.current, Math.max(Date.now(), fireAt))), Math.max(0, fireAt - Date.now()));
    return () => clearTimeout(id);
  }, [started, busy, game, clock, apply, rng, stamp]);

  // tick the ring
  useEffect(() => {
    if (!started || busy || game.winner || !clock) return;
    let raf = 0;
    let lastSec = -1;
    const loop = () => {
      const t = Date.now();
      setNow(t);
      const left = Math.ceil((gameRef.current.deadline - t) / 1000);
      if (gameRef.current.turn === "us" && left <= 2 && left > 0 && left !== lastSec) sfx("tick");
      lastSec = left;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [started, busy, game.winner, clock]);

  const yourTurn = started && !busy && !game.winner && game.turn === "us";
  const sel = selected === null ? null : game.pieces.find((p) => p.id === selected) ?? null;
  const marks = yourTurn && sel ? targets(game, sel) : [];

  const onPiece = (id: number) => {
    if (!yourTurn) return;
    const p = game.pieces.find((x) => x.id === id);
    if (!p || p.army !== "us") return;
    if (selected === id) return setSelected(null);
    setSelected(id);
    const t = targets(game, p);
    if (!t.length) setSay(p.rank === "B" ? "Landmines never move." : p.rank === "F" && p.fuel >= 3 ? "Your Truck is out of fuel." : p.rank === "F" ? "The Truck can't move two of your turns in a row." : "That piece has nowhere to go.");
  };
  const onMark = (sq: Square) => {
    if (!yourTurn || selected === null) return;
    apply(move(game, { id: selected, to: sq, at: stamp(game) }));
  };
  const useTwoStep = () => {
    if (!yourTurn) return;
    const r = startTwoStep(game, stamp(game));
    if (!r.ok) return apply(r);
    commit(r.game);
    setSay("Two-Step Turn: two single steps, one piece twice or two pieces once.");
  };
  const again = () => {
    const g = fresh();
    commit(g);
    setPieces(shownFrom(g));
    setDepots(g.depots);
    setSelected(null);
    setStarted(instant);
    setSay("New setup. Your pieces are face up at the bottom.");
  };

  const left = clock ? Math.max(0, Math.min(1, (game.deadline - now) / TURN_MS)) : 1;
  const count = (a: "us" | "it") => game.pieces.filter((p) => p.army === a).length;
  const plate = (a: "us" | "it") => {
    const active = started && !game.winner && game.turn === a;
    const low = active && clock && left < 0.4;
    return (
      <div className={`vg-plate ${a}${active ? " active" : ""}`}>
        <span className={`vg-ava${low ? " low" : ""}`}>
          <svg className="vg-ring" viewBox="0 0 64 64" aria-hidden="true">
            <circle className="vg-ring-track" cx="32" cy="32" r="29" />
            <circle className="vg-ring-arc" cx="32" cy="32" r="29" pathLength={1} strokeDasharray="1" strokeDashoffset={active ? 1 - (busy ? 1 : left) : 1} />
          </svg>
          <Image className="vg-ava-img" src={art.avatars[a === "us" ? 0 : 4]} alt="" width={44} height={44} />
        </span>
        <span className="vg-who">
          <b>{a === "us" ? "You" : "Bot"}</b>
          <small>{a === "us" ? "US Army" : "Royal Italian Army"} · {count(a)} of 20</small>
        </span>
        {a === "it" && game.twoStep.it > 0 && <span className="vg-tok">Two-Step ×{game.twoStep.it}</span>}
      </div>
    );
  };

  const turn: TurnInfo = {
    label: started && !game.winner ? (game.turn === "us" ? (game.twoStepActive ? `Two-Step · ${game.stepsLeft} left` : "Your turn") : "Italy's turn") : "",
    banked: game.twoStep.us,
    active: game.twoStepActive,
    yourTurn,
    moved: game.movedThisTurn.length > 0,
    onUse: useTwoStep,
  };
  const won = game.winner === "us";
  // casualty tracking: every Italian piece that leaves the board was shown to you, so what is left per rank is known
  const alive = (rank: string) => game.pieces.filter((p) => p.army === "it" && p.rank === rank).length;
  const roster = (
    <div className="vg-roster" role="list" aria-label="Italian pieces still on the board, by rank">
      {ROSTER.map(([rank, n]) => (
        <span key={rank} role="listitem" className={alive(rank) === 0 ? "out" : ""} aria-label={`${NAMES[rank]}: ${alive(rank)} of ${n} left`}>
          <b>{rank}</b>
          {alive(rank)}/{n}
        </span>
      ))}
    </div>
  );
  return (
    <Arena game="vanguard">
      <VanguardScreen
        switchable
        bar={
          <div className="vg-bar">
            <Label>Practice · Vanguard</Label>
            <span className="vg-bar-tools">
              <MuteToggle />
              <FullScreenToggle />
            </span>
          </div>
        }
        foe={plate("it")}
        roster={roster}
        me={plate("us")}
        turn={turn}
        say={say}
        stage={
        <div className="vg-stage">
          <VanguardBoard pieces={pieces} depots={depots} selected={selected} marks={marks} fx={fx} storm={storm} locked={!yourTurn} onPiece={onPiece} onMark={onMark} />
          {!started && (
            <Countdown
              onDone={() => {
                setStarted(true);
                commit(freshClock({ ...gameRef.current, startedAt: Date.now() }));
              }}
            />
          )}
          {call && <Callout key={call.key} text={call.text} tone={call.tone} duration={1300} onDone={() => setCall(null)} className="vg-call" />}
          {game.winner && (
            <div className="cut cut-frame vg-end" role="dialog" aria-label="Match over">
              <p className="vg-end-word">{game.winner === "draw" ? "Draw" : won ? "You won" : "You lost"}</p>
              <p className="note">{game.reason && game.winner !== "draw" ? END_LINE[game.reason][game.winner] : "Move limit reached with equal armies."}</p>
              <dl className="vg-end-stats">
                <div><dt>Turns</dt><dd>{game.turnNo}</dd></div>
                <div><dt>Your pieces left</dt><dd>{count("us")}</dd></div>
                <div><dt>Italian pieces beaten</dt><dd>{20 - count("it")}</dd></div>
              </dl>
              <p className="note">Practice: nothing was staked and no Gemas moved.</p>
              <div className="vg-end-actions">
                <Button onClick={again}>Play again</Button>
                <Button href="/lobby">Lobby</Button>
              </div>
            </div>
          )}
        </div>
        }
      />
    </Arena>
  );
}
