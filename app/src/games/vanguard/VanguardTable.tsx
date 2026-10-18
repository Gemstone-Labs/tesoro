"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Label } from "@/components/ui";
import { art } from "@/lib/art";
import { Arena, Callout, FullScreenToggle, MuteToggle, prefersReducedMotion, sfx, type CalloutTone } from "../fx";
import { STATUS, eventsSince, rankOfCode, type ArmyAccount, type Battle } from "./decode";
import { NAMES, ROSTER, TURN_MS, enemy, targets, type Army, type GameEvent, type Rank, type Square } from "./rules";
import { VanguardBoard, type ShownFx, type ShownPiece, type ShownStorm } from "./VanguardBoard";
import { depotsFor, enemyLeft, fromView, hitSide, indexOf, lookGame, mySide, opposite, piecesLeft, shownPieces, squareOf, toView } from "./view";
import "./vanguard.css";

export interface VanguardTableProps {
  battle: Battle;
  /** Your own Army; the table is drawn once you have it. */
  army: ArmyAccount;
  seat: 0 | 1;
  /** When this client first saw the current turn (ms): the countdown runs from here. */
  turnSeenAt: number;
  /** Send a move (`to` is `row * 10 + col`). Rejects with a plain message when the rollup refused it. */
  onMove: (piece: number, to: number) => Promise<void>;
  onTwoStep: () => Promise<void>;
  /** The Match is over and being settled: no more taps. */
  ended?: boolean;
  children?: ReactNode;
}

const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, prefersReducedMotion() ? 0 : ms));
const slideMs = (a: Square, b: Square) => Math.min(380, 140 + (Math.abs(a.r - b.r) + Math.abs(a.c - b.c)) * 40);

const END_LINE = {
  truck: { won: "You captured their Supply Truck.", lost: "They captured your Supply Truck." },
  stuck: { won: "They have no piece left that can move.", lost: "You have no piece left that can move." },
  timeouts: { won: "They let the clock run out three turns in a row.", lost: "Your clock ran out three turns in a row." },
  cap: { won: "Time limit reached: your surviving ranks add up higher.", lost: "Time limit reached: their surviving ranks add up higher." },
} as const;
const REASONS = ["truck", "stuck", "timeouts", "cap"] as const;

/** The line under the board once the Battle is decided, from this Player's seat. */
export function endLine(b: Battle, seat: number): string {
  if (b.status === STATUS.cancelled) return "The Match was cancelled. Both entries are refunded.";
  const reason = REASONS[b.reason] ?? "cap";
  if (b.winner === 2) return "Time limit reached with equal armies: both entries are refunded.";
  return END_LINE[reason][b.winner === seat ? "won" : "lost"];
}

/**
 * The war-room table for a chain Match. It draws what the Battle and your own Army say, from your side (the
 * Italian Player sees the board turned half way round). A plain move slides at once and is confirmed or snapped
 * back; an attack waits for the program's result, then the events the Battle recorded are played in order.
 */
export function VanguardTable({ battle, army, seat, turnSeenAt, onMove, onTwoStep, ended = false, children }: VanguardTableProps) {
  const side = mySide(battle, seat);
  const foe = enemy(side);
  const [pieces, setPieces] = useState<ShownPiece[]>(() => shownPieces(battle, army, seat));
  const piecesRef = useRef(pieces);
  const [depots, setDepots] = useState(() => depotsFor(battle, side));
  const [fx, setFx] = useState<ShownFx[]>([]);
  const [storm, setStorm] = useState<ShownStorm | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [say, setSay] = useState("Your pieces are face up at the bottom. Tap one, then a marked square.");
  const [animating, setAnimating] = useState(false);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [call, setCall] = useState<{ key: number; text: string; tone: CalloutTone } | null>(null);
  const fxKey = useRef(1);
  const cursor = useRef(battle.eventSeq);
  const latest = useRef({ battle, army });
  latest.current = { battle, army };
  const running = useRef(false);

  const put = useCallback((ps: ShownPiece[]) => {
    piecesRef.current = ps;
    setPieces(ps);
  }, []);
  const patch = useCallback((id: number, p: Partial<ShownPiece>) => put(piecesRef.current.map((x) => (x.id === id ? { ...x, ...p } : x))), [put]);
  const shout = useCallback((text: string, tone: CalloutTone = "plain") => setCall({ key: fxKey.current++, text, tone }), []);
  const addFx = useCallback((kind: ShownFx["kind"], r: number, c: number, size: number) => {
    const key = fxKey.current++;
    setFx((f) => [...f, { key, kind, r, c, size }]);
    setTimeout(() => setFx((f) => f.filter((x) => x.key !== key)), 800);
  }, []);

  /** Play the recorded events one beat at a time, then show the settled Battle. */
  const play = useCallback(
    async (events: GameEvent[], b: Battle) => {
      const find = (id: number) => piecesRef.current.find((p) => p.id === id);
      /** A rank the Player may know: shown on the piece, or published by the Battle. */
      const rankOf = (id: number): Rank | null => find(id)?.rank ?? rankOfCode(b.shown[id]);
      const mineId = (id: number) => (id >= 30 ? "us" : "it") === side;
      let line = "";
      setSelected(null);
      for (const e of events) {
        if (e.kind === "move") {
          const from = toView(e.from, side);
          const to = toView(e.to, side);
          const cur = find(e.id);
          if (cur && cur.r === to.r && cur.c === to.c) continue; // your own move, already on the board
          const ms = slideMs(from, to);
          patch(e.id, { r: to.r, c: to.c, ms });
          sfx("knock");
          await wait(ms);
          if (!mineId(e.id)) line = "Your opponent moved.";
        } else if (e.kind === "attack") {
          const from = toView(e.from, side);
          const to = toView(e.to, side);
          const dr = Math.sign(to.r - from.r);
          const dc = Math.sign(to.c - from.c);
          const edge = { r: to.r - dr * 0.55, c: to.c - dc * 0.55 };
          patch(e.att, { r: edge.r, c: edge.c, ms: slideMs(from, edge) });
          await wait(slideMs(from, edge));
          // the faces the program published: the beaten piece, both in a tie, a Landmine that went off
          const toward = hitSide(e.from, e.to, side);
          const shown = e.flash.filter((id) => !mineId(id));
          const aRank = rankOf(e.att);
          const dRank = rankOf(e.def);
          if (shown.length) {
            shown.forEach((id) => patch(id, { up: true, rank: rankOfCode(b.shown[id]), hitFrom: id === e.def ? toward : opposite(toward) }));
            sfx("flip");
            await wait(820);
          }
          const mid = { r: (edge.r + to.r) / 2 + 0.5, c: (edge.c + to.c) / 2 + 0.5 };
          if (e.outcome === "mine") addFx("mine", to.r + 0.5, to.c + 0.5, 2.6);
          else addFx("clash", mid.r, mid.c, 1.9);
          sfx(e.outcome === "mine" ? "blast" : "clash");
          await wait(200);
          const attWins = e.outcome === "win" || e.outcome === "defuse" || e.outcome === "truck";
          const gone = e.outcome === "tie" ? [e.att, e.def] : attWins ? [e.def] : [e.att];
          gone.forEach((id) => patch(id, { gone: true }));
          await wait(300);
          if (attWins) {
            patch(e.att, { r: to.r, c: to.c, ms: 160 });
            await wait(160);
          }
          const mine = mineId(e.att);
          const a = aRank ? NAMES[aRank] : "piece";
          line =
            e.outcome === "truck" ? (mine ? "Supply Truck captured!" : "Your opponent reached your Supply Truck.")
            : e.outcome === "mine" ? (mine ? `Landmine! Your ${a} is lost, and the mine is now in plain sight. Only an Engineer (3) clears mines.` : "Your opponent hit one of your Landmines. It is in plain sight now.")
            : e.outcome === "defuse" ? (mine ? "Your Engineer cleared a Landmine." : "An enemy Engineer cleared your Landmine.")
            : e.outcome === "tie" ? `Both ${a}s fall.`
            : mine ? (attWins ? `Your ${aRank} beat their ${dRank}.` : `Your ${aRank} lost. The piece that beat it stays hidden.`)
            : attWins ? `Your opponent took your ${dRank} with a hidden piece.` : `Your ${dRank} held: it beat their ${aRank}.`;
        } else if (e.kind === "spotted") {
          const p = find(e.id);
          patch(e.id, { up: true, rank: "F", hitFrom: "bottom" });
          if (p) addFx("spotted", p.r + 0.5, p.c + 0.5, 2.8);
          sfx("fold");
          const own = mineId(e.id);
          shout(own ? "Your Truck is Spotted!" : "Spotted!", "warn");
          line = own ? "Your Supply Truck is out of fuel: Spotted, face up and stuck." : "Their Supply Truck is Spotted: face up and out of fuel.";
          await wait(500);
        } else if (e.kind === "raid") {
          const at = toView(e.at, side);
          setDepots((ds) => ds.map((d) => (d.r === at.r && d.c === at.c ? { ...d, claimed: true } : d)));
          addFx("spotted", at.r + 0.5, at.c + 0.5, 1.7);
          sfx("check");
          shout(e.army === side ? "Two-Step Turn earned" : "They raided your depot");
          line = e.army === side ? "Depot raided: you earned a Two-Step Turn. Spend it on any turn." : "They raided your depot and earned a Two-Step Turn.";
          await wait(500);
        } else if (e.kind === "storm") {
          const index = side === "us" ? e.index : 9 - e.index;
          const dir = side === "us" ? e.dir : (-e.dir as 1 | -1);
          setStorm({ key: Date.now(), axis: e.axis, index, dir });
          sfx("wind");
          shout("Dust storm!", "warn");
          setSay(`Dust storm over ${e.axis === "row" ? `row ${10 - index}` : `column ${index + 1}`}!`);
          await wait(1500);
          e.shifts.forEach((s) => {
            const to = toView(s.to, side);
            patch(s.id, { r: to.r, c: to.c, ms: 420 });
          });
          await wait(2000);
          setStorm(null);
          line = `The storm drifted ${e.shifts.length} ${e.shifts.length === 1 ? "piece" : "pieces"} one square. Check where yours went.`;
        } else if (e.kind === "turn" && e.timedOut) {
          line = e.turn === side ? "Time! Your turn passed." : "Your opponent ran out of time.";
        }
      }
      const { army: mineNow } = latest.current;
      put(shownPieces(b, mineNow, seat));
      setDepots(depotsFor(b, side));
      cursor.current = b.eventSeq;
      if (b.status === STATUS.over || b.status === STATUS.cancelled) {
        sfx(b.winner === seat ? "win" : "lose");
        setSay(endLine(b, seat));
      } else if (line) setSay(line);
    },
    [addFx, patch, put, seat, shout, side],
  );

  // New Battle state: play what is new, or snap to the board when too far behind.
  useEffect(() => {
    if (running.current) return;
    running.current = true;
    void (async () => {
      setAnimating(true);
      try {
        for (;;) {
          const b = latest.current.battle;
          if (b.eventSeq === cursor.current && b.status < STATUS.over) break;
          const c = eventsSince(b, cursor.current);
          if (c.kind === "snap") {
            put(shownPieces(b, latest.current.army, seat));
            setDepots(depotsFor(b, side));
            cursor.current = b.eventSeq;
          } else if (c.events.length) await play(c.events, b);
          else {
            cursor.current = b.eventSeq;
            if (b.status >= STATUS.over) setSay(endLine(b, seat));
          }
          if (latest.current.battle === b) break;
        }
      } finally {
        running.current = false;
        setAnimating(false);
      }
    })();
  }, [battle, play, put, seat, side]);

  // A taken move is no longer pending once the turn moved on.
  const turnNow = `${battle.turnNo}:${battle.moves}:${battle.stepsLeft}`;
  useEffect(() => setSentAt(null), [turnNow]);

  // the countdown ring
  const live = battle.status === STATUS.live && !ended;
  useEffect(() => {
    if (!live) return;
    let raf = 0;
    let lastSec = -1;
    const loop = () => {
      const t = Date.now();
      setNow(t);
      const left = Math.ceil((turnSeenAt + TURN_MS - t) / 1000);
      if (battle.turn === (side === "us" ? 0 : 1) && left <= 2 && left > 0 && left !== lastSec) sfx("tick");
      lastSec = left;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [live, turnSeenAt, battle.turn, side]);

  const game = useMemo(() => lookGame(battle, army, seat), [battle, army, seat]);
  const yourTurn = live && !animating && sentAt === null && battle.turn === (side === "us" ? 0 : 1);
  const sel = selected === null ? null : game.pieces.find((p) => p.id === selected) ?? null;
  const marks = yourTurn && sel ? targets(game, sel).map((t) => ({ ...toView(t, side), attack: t.attack })) : [];

  const onPiece = (id: number) => {
    if (!yourTurn) return;
    const p = game.pieces.find((x) => x.id === id);
    if (!p || p.army !== side) return;
    if (selected === id) return setSelected(null);
    setSelected(id);
    const t = targets(game, p);
    if (!t.length) setSay(p.rank === "B" ? "Landmines never move." : p.rank === "F" && p.fuel >= 3 ? "Your Truck is out of fuel." : p.rank === "F" ? "The Truck can't move two of your turns in a row." : "That piece has nowhere to go.");
  };

  const snapBack = useCallback(
    (message: string) => {
      put(shownPieces(latest.current.battle, latest.current.army, seat));
      setSentAt(null);
      setSelected(null);
      setSay(message);
    },
    [put, seat],
  );

  const onMark = (mark: Square & { attack: boolean }) => {
    if (!yourTurn || selected === null) return;
    const to = fromView(mark, side);
    const piece = selected;
    setSentAt(turnNow);
    setSelected(null);
    if (!mark.attack) {
      // a plain move slides at once; the program confirms it, or the piece goes back
      patch(piece, { r: mark.r, c: mark.c, ms: slideMs(piecesRef.current.find((p) => p.id === piece) ?? mark, mark) });
      sfx("knock");
    } else setSay("Attacking…");
    onMove(piece, indexOf(to)).catch((e: Error) => snapBack(e.message || "That move did not go through."));
  };

  const twoStepLeft = battle.twoStep[side === "us" ? 0 : 1];
  const useTwoStep = () => {
    if (!yourTurn) return;
    setSentAt(turnNow);
    onTwoStep()
      .then(() => setSay("Two-Step Turn: two single steps, one piece twice or two pieces once."))
      .catch((e: Error) => snapBack(e.message || "That did not go through."));
  };

  const left = live ? Math.max(0, Math.min(1, (turnSeenAt + TURN_MS - now) / TURN_MS)) : 0;
  const plate = (a: Army) => {
    const mineP = a === side;
    const active = live && battle.turn === (a === "us" ? 0 : 1);
    const low = active && left < 0.4;
    const banked = battle.twoStep[a === "us" ? 0 : 1];
    return (
      <div className={`vg-plate ${a}${active ? " active" : ""}`}>
        <span className={`vg-ava${low ? " low" : ""}`}>
          <svg className="vg-ring" viewBox="0 0 64 64" aria-hidden="true">
            <circle className="vg-ring-track" cx="32" cy="32" r="29" />
            <circle className="vg-ring-arc" cx="32" cy="32" r="29" pathLength={1} strokeDasharray="1" strokeDashoffset={active ? 1 - (animating ? 1 : left) : 1} />
          </svg>
          <Image className="vg-ava-img" src={art.avatars[a === "us" ? 0 : 4]} alt="" width={44} height={44} />
        </span>
        <span className="vg-who">
          <b>{mineP ? "You" : "Opponent"}</b>
          <small>{a === "us" ? "US Army" : "Royal Italian Army"} · {piecesLeft(battle, a)} of 20</small>
        </span>
        {active && <span className="vg-turn">{mineP ? (battle.twoStepActive ? `Two-Step · ${battle.stepsLeft} left` : "Your turn") : "Their turn"}</span>}
        {mineP && twoStepLeft > 0 && !battle.twoStepActive && (
          <button type="button" className="vg-two" onClick={useTwoStep} disabled={!yourTurn || battle.moved !== 0n}>
            Use Two-Step Turn{twoStepLeft > 1 ? ` ×${twoStepLeft}` : ""}
          </button>
        )}
        {!mineP && banked > 0 && <span className="vg-tok">Two-Step ×{banked}</span>}
      </div>
    );
  };

  const standing = enemyLeft(battle, seat);
  const roster = (
    <div className="vg-roster" role="list" aria-label={`${foe === "us" ? "US" : "Italian"} pieces still on the board, by rank`}>
      {ROSTER.map(([rank, n]) => (
        <span key={rank} role="listitem" className={standing[rank] === 0 ? "out" : ""} aria-label={`${NAMES[rank]}: ${standing[rank]} of ${n} left`}>
          <b>{rank}</b>
          {standing[rank]}/{n}
        </span>
      ))}
    </div>
  );

  return (
    <Arena game="vanguard">
      <div className="vg-screen">
        <div className="vg-bar">
          <Label>Vanguard</Label>
          <span className="vg-bar-tools">
            <MuteToggle />
            <FullScreenToggle />
          </span>
        </div>
        {plate(foe)}
        {roster}
        <div className="vg-stage">
          <VanguardBoard pieces={pieces} depots={depots} selected={selected} marks={marks} fx={fx} storm={storm} locked={!yourTurn} viewer={side} onPiece={onPiece} onMark={onMark} />
          {call && <Callout key={call.key} text={call.text} tone={call.tone} duration={1300} onDone={() => setCall(null)} className="vg-call" />}
        </div>
        {plate(side)}
        <p className="vg-say" aria-live="polite">{say}</p>
        {children}
      </div>
    </Arena>
  );
}
