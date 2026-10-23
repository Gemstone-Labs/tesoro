"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui";
import { art } from "@/lib/art";
import { Arena, Callout, Countdown, prefersReducedMotion, sfx, type CalloutTone } from "../../fx";
import { CAP_MS, NAMES, TURN_MS, act, move, newGame, rankOf, seeded, startTwoStep, targets, timeout, type Army, type Depot, type Game, type GameEvent, type Rank, type Refusal, type Result, type Rng, type Square } from "../rules";
import { PRACTICE_COUNTDOWN, missedLabel } from "../clock";
import { ArmyCount, VanguardScreen, VgBar, type TurnInfo } from "../VanguardScreen";
import { VanguardBoard, type HitSide, type Mark, type Preview, type ShownFx, type ShownPiece, type ShownStorm } from "../VanguardBoard";
import { RulesSheet } from "../RulesSheet";
import { blastSquares, canSwitch, isJump, observe, powerBlockedLine, powerFor, rosterView, type Ledger } from "../powers-ui";
import { applyBot, botMove, type Policy } from "./bot";
import { PracticePauseButton, PracticePauseOverlay, usePracticePause } from "../../fx/PracticePause";
import "../vanguard.css";

export interface VanguardPracticeProps {
  /** Fixed setup and bot (stories, tests). */
  seed?: number;
  /** Skip the get-ready countdown. */
  instant?: boolean;
  /** Turn clock on (the real 10 seconds); off for a calm look around. */
  clock?: boolean;
  /** Blow the Dust Storm on this turn instead of a random one. */
  stormAt?: number;
  /** Start with Two-Step Turns banked (to try one without raiding first). */
  twoStep?: number;
  /** Change the opening position (stories: put pieces in contact). */
  prepare?: (g: Game) => Game;
  /** The bot's style (stories: the fortress bot digs in at once). */
  policy?: Policy;
  /** Who moves first (stories: let the bot go first). */
  first?: Army;
  /** What you were already shown of Italy's pieces (stories: the roster strip). */
  seen?: Ledger;
}

const REFUSAL_LINE: Record<Refusal, string> = {
  match_over: "Match is over.",
  cap_passed: "Time is up.",
  turn_expired: "Too late: time ran out.",
  turn_not_expired: "",
  not_your_turn: "Not your turn.",
  no_such_piece: "Piece is gone.",
  illegal_move: "Can't go there.",
  no_two_step: "No Two-Step Turn left.",
};

const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, prefersReducedMotion() ? 0 : ms));
/** A Lieutenant's jump or a General's wadi crossing is a hop: lift, arc over the squares between, land. */
const HOP_MS = 620;
const slideMs = (a: Square, b: Square) => Math.min(380, 140 + (Math.abs(a.r - b.r) + Math.abs(a.c - b.c)) * 40);

/** What the US Player sees: own faces always, Italian faces only once known. */
function shownFrom(g: Game): ShownPiece[] {
  // a private change is shown to its owner; both armies' changes are shown once the Match is over
  return g.pieces.map((p) => ({
    id: p.id,
    army: p.army,
    rank: rankOf(g, p),
    r: p.r,
    c: p.c,
    up: p.army === "us" || p.known,
    changed: p.army === "us" || g.winner ? g.changed[p.id] : undefined,
    exposed: p.army === "us" && p.known && !g.winner,
  }));
}

/** A rank in a line of text: the Spy by name. */
const rk = (r: Rank) => (r === "1" ? "Spy" : r === "B" ? "Landmine" : r);

const END_LINE = {
  truck: { us: "You captured Italy's Truck.", it: "Italy captured your Truck." },
  stuck: { us: "Italy can't move.", it: "You can't move." },
  timeouts: { us: "Italy ran out of time.", it: "You ran out of time." },
  cap: { us: "Limit reached: you were ahead.", it: "Limit reached: Italy was ahead." },
} as const;

/**
 * Vanguard practice: you play the US against a local bot, on the real rules (rules.ts) with the 10-second
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

function PracticeMatch({ seed, instant = false, clock = true, stormAt, twoStep = 0, prepare, policy = "standard", first = "us", seen }: VanguardPracticeProps) {
  const { paused, toggle: togglePause, now: practiceNow } = usePracticePause();
  // one random source per mount: seeded in stories, so the setup and the bot repeat
  const [rng] = useState<Rng>(() => (seed === undefined ? Math.random : seeded(seed)));
  const fresh = useCallback(() => {
    const g = newGame(rng, practiceNow(), first);
    const ready = { ...g, stormAt: stormAt ?? g.stormAt, twoStep: { us: twoStep, it: 0 } };
    return prepare ? prepare(ready) : ready;
  }, [rng, stormAt, twoStep, prepare, first, practiceNow]);
  const [game, setGame] = useState<Game>(fresh);
  const gameRef = useRef(game);
  const [pieces, setPieces] = useState<ShownPiece[]>(() => shownFrom(game));
  const [depots, setDepots] = useState<Depot[]>(game.depots);
  const [fx, setFx] = useState<ShownFx[]>([]);
  const [storm, setStorm] = useState<ShownStorm | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  /** Become a Spy was tapped: it rides on this turn's action (a move, an attack or a power), and is dropped if the turn ends without one. */
  const [spyOn, setSpyOn] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [ledger, setLedger] = useState<Ledger>(() => seen ?? {});
  const ledgerRef = useRef(ledger);
  const [say, setSay] = useState("Your move. Tap a piece.");
  const [started, setStarted] = useState(instant);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => practiceNow());
  const fxKey = useRef(1);
  const [call, setCall] = useState<{ key: number; text: string; tone: CalloutTone } | null>(null);
  const shout = useCallback((text: string, tone: CalloutTone = "plain") => setCall({ key: fxKey.current++, text, tone }), []);

  const commit = useCallback((g: Game) => {
    gameRef.current = g;
    setGame(g);
    setSpyOn(false);
  }, []);
  /** The time an action is stamped with: the real clock, or a fixed instant when the clock is off. */
  const stamp = useCallback((g: Game) => (clock ? practiceNow() : g.startedAt), [clock, practiceNow]);
  /** Give the side to act a full turn from now (the screen shows the countdown from when it sees the turn begin). */
  const freshClock = useCallback((g: Game): Game => (clock ? { ...g, deadline: practiceNow() + TURN_MS } : g), [clock, practiceNow]);
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
    setSpyOn(false);
    const before = gameRef.current;
    const name = (id: number) => before.pieces.find((p) => p.id === id);
    let line = "";
    // your General of the Army became a Spy (secret: the rules emit no event for a face-down one)
    for (const [k, c] of Object.entries(g.changed)) {
      const id = Number(k);
      if (before.changed[id] || c !== "spy" || name(id)?.army !== "us") continue;
      patch(id, { rank: "1", changed: "spy", fresh: true });
      sfx("check");
      shout("Now a Spy");
      setSay("Your 10 is a Spy for good.");
      await wait(600);
    }
    for (const e of events) {
      if (e.kind === "move") {
        const hop = isJump(rankOf(before, name(e.id)!), e.from, e.to);
        const ms = hop ? HOP_MS : slideMs(e.from, e.to);
        patch(e.id, { r: e.to.r, c: e.to.c, ms, hop });
        sfx(hop ? "wind" : "knock");
        await wait(ms);
        if (hop) {
          sfx("knock");
          patch(e.id, { hop: false });
        }
        if (name(e.id)?.army === "it") line = "Italy moved.";
      } else if (e.kind === "attack") {
        const a = name(e.att)!;
        const d = name(e.def)!;
        const dr = Math.sign(e.to.r - e.from.r);
        const dc = Math.sign(e.to.c - e.from.c);
        const edge = { r: e.to.r - dr * 0.55, c: e.to.c - dc * 0.55 };
        const hop = isJump(rankOf(before, a), e.from, e.to);
        const approach = hop ? HOP_MS : slideMs(e.from, edge);
        patch(e.att, { r: edge.r, c: edge.c, ms: approach, hop });
        if (hop) sfx("wind");
        await wait(approach);
        if (hop) patch(e.att, { hop: false });
        // the beaten piece's face is flashed to the winner; from the US side that means Italian pieces only
        const flashIt = e.flash.filter((id) => name(id)?.army === "it");
        if (flashIt.length) {
          // the defender was hit on the side facing the attacker; the attacker on its leading side
          const toward: HitSide = dc > 0 ? "left" : dc < 0 ? "right" : dr > 0 ? "top" : "bottom";
          const away: HitSide = ({ left: "right", right: "left", top: "bottom", bottom: "top" } as const)[toward];
          flashIt.forEach((id) => patch(id, { up: true, rank: rankOf(g, name(id)!), hitFrom: id === e.def ? toward : away }));
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
        // the ranks they fought as: a switched 10 fights, and dies, as a Spy
        const ar = rk(rankOf(g, a));
        const dd = rk(rankOf(g, d));
        line =
          e.outcome === "truck" ? (mine ? "Supply Truck captured!" : "Italy took your Truck.")
          : e.outcome === "mine" ? (mine ? `Landmine! Your ${ar} is lost.` : "Italy hit your Landmine.")
          : e.outcome === "defuse" ? (mine ? "Your Engineer cleared a Landmine." : "Italy cleared your Landmine.")
          : e.outcome === "tie" ? `Both ${ar}s fall.`
          : mine ? (attWins ? `Your ${ar} beat their ${dd}.` : `Your ${ar} lost.`)
          : attWins ? `Italy took your ${dd}.` : `Your ${dd} held.`;
      } else if (e.kind === "blast") {
        const eng = name(e.id)!;
        const mine = eng.army === "us";
        if (!mine) {
          patch(e.id, { up: true, rank: "3", hitFrom: "top" });
          sfx("flip");
          await wait(700);
        }
        addFx("mine", e.at.r + 0.5, e.at.c + 0.5, 3.6);
        sfx("blast");
        shout("Engineer blast!", mine ? "plain" : "warn");
        patch(e.id, { gone: true });
        await wait(260);
        const turned = e.shown.filter((s) => name(s.id)?.army === "it" && !name(s.id)!.known);
        e.shown.forEach((s) => {
          const q = name(s.id);
          if (!q) return;
          if (q.army === "us") return patch(s.id, { exposed: true });
          if (q.known) return;
          const dr = Math.sign(q.r - e.at.r);
          const dc = Math.sign(q.c - e.at.c);
          patch(s.id, { up: true, rank: s.rank, hitFrom: dc > 0 ? "left" : dc < 0 ? "right" : dr > 0 ? "top" : "bottom" });
        });
        if (turned.length) sfx("flip");
        const own = e.shown.filter((s) => name(s.id)?.army === "us").length;
        line = mine ? (turned.length ? `Blast showed ${turned.length} Italian ${turned.length === 1 ? "piece" : "pieces"}.` : "Blast: nothing hidden nearby.") : `Italy's Blast showed ${own} of your ${own === 1 ? "piece" : "pieces"}.`;
        await wait(turned.length ? 820 : 300);
      } else if (e.kind === "rescue") {
        const col = name(e.colonel)!;
        const mine = col.army === "us";
        if (!mine) {
          patch(e.colonel, { up: true, rank: "8", hitFrom: "top" });
          sfx("flip");
          await wait(700);
        }
        addFx("mine", e.to.r + 0.5, e.to.c + 0.5, 2.8);
        sfx("blast");
        patch(e.colonel, { gone: true });
        await wait(300);
        addFx("dust", e.from.r + 0.5, e.from.c + 0.5, 2.4);
        sfx("wind");
        patch(e.truck, { r: e.to.r, c: e.to.c, ms: 700, fly: true, ...(mine ? {} : { up: true, rank: "F" as Rank, hitFrom: "bottom" as HitSide }) });
        shout("Truck rescued!", mine ? "plain" : "warn");
        await wait(720);
        addFx("dust", e.to.r + 0.5, e.to.c + 0.5, 2.4);
        patch(e.truck, { fly: false });
        line = mine ? "Truck rescued: it jumped to your Colonel's square." : "Italy rescued its Truck. It is face up now.";
        await wait(300);
      } else if (e.kind === "dug_in") {
        // only a face-up Major's Dig in is named (F1): everyone sees its new face. The owner's own is handled with the pass below.
        if (e.army === "it") patch(e.id, { rank: "B", fresh: true });
      } else if (e.kind === "pass") {
        // a face-down Dig in is a pass event: with no Pass button the opponent is told a Major dug in, never which one
        if (e.army === "it") line = "Italy's Major dug in somewhere.";
        else {
          const id = Object.keys(g.changed).map(Number).find((k) => g.changed[k] === "dug" && !before.changed[k] && name(k)?.army === "us");
          if (id === undefined) line = "You passed.";
          else {
            patch(id, { rank: "B", changed: "dug", fresh: true });
            shout("Dug in");
            line = "Your Major is a Landmine now.";
            sfx("knock");
            await wait(650);
          }
        }
      } else if (e.kind === "switched") {
        // a face-up 10 switching is public (an own one was handled above)
        if (name(e.id)?.army === "it") {
          patch(e.id, { rank: "1", fresh: true });
          shout("Their 10 became a Spy", "warn");
          line = "Italy's 10 became a Spy.";
          sfx("check");
          await wait(600);
        }
      } else if (e.kind === "spotted") {
        const p = name(e.id) ?? g.pieces.find((x) => x.id === e.id)!;
        patch(e.id, { up: true, hitFrom: "bottom" });
        addFx("spotted", p.r + 0.5, p.c + 0.5, 2.8);
        sfx("fold");
        shout(p.army === "us" ? "Your Truck is Spotted!" : "Spotted!", "warn");
        line = p.army === "us" ? "Your Truck is Spotted." : "Italy's Truck is Spotted.";
        await wait(500);
      } else if (e.kind === "raid") {
        setDepots((ds) => ds.map((d) => (d.r === e.at.r && d.c === e.at.c ? { ...d, claimed: true } : d)));
        addFx("spotted", e.at.r + 0.5, e.at.c + 0.5, 1.7);
        sfx("check");
        shout(e.army === "us" ? "Two-Step Turn earned" : "Italy raided your depot");
        line = e.army === "us" ? "Depot raided: Two-Step Turn." : "Italy raided your depot.";
        await wait(500);
      } else if (e.kind === "storm") {
        setStorm({ key: practiceNow(), axis: e.axis, index: e.index, dir: e.dir });
        sfx("wind");
        shout("Dust storm!", "warn");
        setSay(`Dust storm: ${e.axis === "row" ? `row ${10 - e.index}` : `column ${e.index + 1}`}.`);
        await wait(1000);
        e.shifts.forEach((s) => patch(s.id, { r: s.to.r, c: s.to.c, ms: 1200, drift: true }));
        await wait(2500);
        e.shifts.forEach((s) => patch(s.id, { drift: false }));
        setStorm(null);
        line = `Storm drifted ${e.shifts.length} ${e.shifts.length === 1 ? "piece" : "pieces"}.`;
      } else if (e.kind === "turn" && e.timedOut) {
        line = e.turn === "us" ? "Italy's time ran out." : "Time! Turn passed.";
      }
    }
    setPieces(shownFrom(g));
    setDepots(g.depots);
    ledgerRef.current = observe(ledgerRef.current, events, before, g);
    setLedger(ledgerRef.current);
    commit(freshClock(g));
    if (g.winner) {
      sfx(g.winner === "us" ? "win" : "lose");
    } else if (line) setSay(line);
    // every move gets a fresh 10 seconds, each step of a Two-Step Turn included (founder 2026-10-19)
    setBusy(false);
  }, [addFx, commit, freshClock, patch, shout, practiceNow]);

  /** Play an accepted action; say why a refused one was. */
  const apply = useCallback((r: Result) => {
    if (!r.ok) {
      if (REFUSAL_LINE[r.reason]) setSay(REFUSAL_LINE[r.reason]);
      return;
    }
    if (r.events.length) void animate(r.events, r.game);
    else commit(r.game);
  }, [animate, commit]);

  // the clock: Italy thinks for a beat, then moves; your turn times out after 10 seconds
  useEffect(() => {
    if (paused || !started || busy || game.winner) return;
    if (game.turn === "it") {
      const id = setTimeout(() => {
        let g = gameRef.current;
        const m = botMove(g, rng, policy);
        if (!m) return apply(timeout(g, Math.max(stamp(g), g.deadline + 1)));
        if (m.twoStep) {
          const s = startTwoStep(g, stamp(g));
          if (s.ok) g = s.game;
        }
        apply(applyBot(g, m, stamp(g)));
      }, game.movedThisTurn.length ? 350 : 700 + Math.random() * 600);
      return () => clearTimeout(id);
    }
    if (!clock) return;
    // fires just past the turn deadline, or past the time cap if that comes first
    const fireAt = Math.min(game.deadline, game.startedAt + CAP_MS) + 1;
    const id = setTimeout(() => apply(timeout(gameRef.current, Math.max(practiceNow(), fireAt))), Math.max(0, fireAt - practiceNow()));
    return () => clearTimeout(id);
  }, [paused, started, busy, game, clock, apply, rng, stamp, policy, practiceNow]);

  // tick the ring
  useEffect(() => {
    if (paused || !started || busy || game.winner || !clock) return;
    let raf = 0;
    let lastSec = -1;
    const loop = () => {
      const t = practiceNow();
      setNow(t);
      const left = Math.ceil((gameRef.current.deadline - t) / 1000);
      if (gameRef.current.turn === "us" && left <= 2 && left > 0 && left !== lastSec) sfx("tick");
      lastSec = left;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [paused, started, busy, game.winner, clock, practiceNow]);

  const yourTurn = started && !paused && !busy && !game.winner && game.turn === "us";
  const sel = selected === null ? null : game.pieces.find((p) => p.id === selected) ?? null;
  const power = yourTurn && sel ? powerFor(game, sel) : null;
  const marks: Mark[] = yourTurn && sel ? targets(game, sel).map((m) => ({ ...m, jump: isJump(rankOf(game, sel), sel, m) })) : [];
  // what a power will do is drawn while its piece is selected: no extra tap
  const truck = sel && power?.kind === "rescue" ? game.pieces.find((p) => p.army === "us" && p.rank === "F") : undefined;
  const preview: Preview | null = !sel || !power?.preview ? null : power.kind === "blast" ? { kind: "blast", squares: blastSquares(sel) } : truck ? { kind: "rescue", from: truck, to: sel } : null;
  /** The General of the Army that Become a Spy would switch: shown as a Spy as soon as the button is tapped. */
  const tenId = spyOn ? game.pieces.find((p) => p.army === "us" && canSwitch(game, p))?.id : undefined;

  const choose = (id: number | null) => setSelected(id);
  const onPiece = (id: number) => {
    if (!yourTurn) return;
    const p = game.pieces.find((x) => x.id === id);
    if (!p || p.army !== "us") return;
    if (selected === id) return choose(null);
    choose(id);
    const t = targets(game, p);
    const rank = rankOf(game, p);
    if (!t.length && !powerFor(game, p)) setSay(rank === "B" ? "Landmines never move." : rank === "F" && p.fuel >= 3 ? "Truck out of fuel." : rank === "F" ? "Truck can't move twice running." : "Nowhere to go.");
    else setSay(powerBlockedLine(game, p) || (powerFor(game, p) ? "Move it, or use its power." : canSwitch(game, p) ? "Move it, or Become a Spy first." : "Pick a marked square."));
  };
  const onMark = (sq: Square) => {
    if (!yourTurn || selected === null) return;
    apply(move(game, { id: selected, to: sq, at: stamp(game), switch: spyOn }));
  };
  const pressPower = () => {
    if (!yourTurn || !sel || !power) return;
    apply(act(game, { kind: power.kind, id: sel.id, at: stamp(game), switch: spyOn }));
  };
  const toggleSpy = () => {
    setSpyOn(!spyOn);
    setSay(spyOn ? "Spy taken back." : "One way: it stays a Spy.");
  };
  const closeRules = useCallback(() => setRulesOpen(false), []);
  const useTwoStep = () => {
    if (!yourTurn) return;
    const r = startTwoStep(game, stamp(game));
    if (!r.ok) return apply(r);
    commit(r.game);
    setSay("Two steps this turn.");
  };
  const again = () => {
    const g = fresh();
    commit(g);
    setPieces(shownFrom(g));
    setDepots(g.depots);
    choose(null);
    ledgerRef.current = seen ?? {};
    setLedger(ledgerRef.current);
    setRulesOpen(false);
    setStarted(instant);
    setSay("New setup.");
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
          <ArmyCount army={a} left={count(a)} />
        </span>
        {missedLabel(game.timeouts[a]) && <span className={`vg-missed${game.timeouts[a] >= 2 ? " last" : ""}`}>{missedLabel(game.timeouts[a])}</span>}
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
    power: power ? { label: power.label, hint: power.hint, onPress: pressPower } : null,
    spy: yourTurn && sel && canSwitch(game, sel) ? { on: spyOn, onPress: toggleSpy } : null,
  };
  const won = game.winner === "us";
  // the strip counts what you were shown (dead pieces included), never the hidden board; a Dig in is secret and not counted
  const rv = rosterView(game, ledger);
  const roster = (
    <div className="vg-roster" role="list" aria-label="Italian pieces still on the board, by rank">
      {rv.cells.map(({ rank, of, left }) => (
        <span
          key={rank}
          role="listitem"
          className={`${left === 0 ? "out" : ""}${rank === "10" && rv.tenOrSpy ? " maybe" : ""}`}
          aria-label={`${NAMES[rank]}: ${left} of ${of} left${rank === "10" && rv.tenOrSpy ? ", may be a Spy now" : ""}`}
        >
          <b>{rank}</b>
          {left}/{of}
        </span>
      ))}
    </div>
  );
  return (
    <Arena game="vanguard" autoFull={!game.winner}>
      <VanguardScreen
        bar={<VgBar practice pause={<PracticePauseButton paused={paused} onToggle={togglePause} disabled={!started || busy || !!game.winner} />} onRules={() => setRulesOpen((o) => !o)} />}
        foe={plate("it")}
        roster={roster}
        me={plate("us")}
        turn={turn}
        say={say}
        stage={
        <div className="vg-stage">
          {paused && <PracticePauseOverlay onResume={togglePause} />}
          <VanguardBoard pieces={tenId === undefined ? pieces : pieces.map((p) => (p.id === tenId ? { ...p, rank: "1", changed: "spy" } : p))} depots={depots} selected={selected} marks={marks} preview={preview} fx={fx} storm={storm} locked={!yourTurn} onPiece={onPiece} onMark={onMark} />
          {!started && (
            <Countdown
              {...PRACTICE_COUNTDOWN}
              className="vg-count"
              onDone={() => {
                setStarted(true);
                commit(freshClock({ ...gameRef.current, startedAt: practiceNow() }));
              }}
            />
          )}
          {rulesOpen && <RulesSheet onClose={closeRules} />}
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
              <div className="vg-end-actions">
                <Button onClick={again}>Play again</Button>
                <Button href="/play">Back to games</Button>
              </div>
            </div>
          )}
        </div>
        }
      />
    </Arena>
  );
}
