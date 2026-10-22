"use client";

import { BookOpen } from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Label } from "@/components/ui";
import { art } from "@/lib/art";
import { Arena, Callout, Countdown, FullScreenToggle, MuteToggle, prefersReducedMotion, sfx, type CalloutTone } from "../fx";
import { STATUS, changeOfCode, rankOfCode, type ArmyAccount, type Battle } from "./decode";
import { catchUp, pendingOf, turnLine } from "./catchup";
import { NAMES, rankOf as playedRank, targets, type Army, type GameEvent, type Rank, type Square } from "./rules";
import { endLine } from "./end";
import { START_COUNTDOWN, getReadyLeft, isOpening, missedLabel, ringLeft, ringStart, turnKey, turnMsOf } from "./clock";
import { VanguardScreen, type TurnInfo } from "./VanguardScreen";
import { VanguardBoard, type HitSide, type Mark, type Preview, type ShownFx, type ShownPiece, type ShownStorm } from "./VanguardBoard";
import { RulesSheet } from "./RulesSheet";
import { blastSquares, canSwitch, isHopMove, isJump, powerBlockedLine, powerFor } from "./powers-ui";
import type { ActionOptions } from "./useVanguardMatch";
import { chainRoster, depotsFor, fromView, hitSide, indexOf, lookGame, opposite, piecesLeft, shownPieces, shownTen, toView } from "./view";
import "./vanguard.css";

export interface VanguardTableProps {
  battle: Battle;
  /** Your own Army; the table is drawn once you have it. */
  army: ArmyAccount;
  seat: 0 | 1;
  /** When this client first saw the current turn (ms): the countdown runs from here. */
  turnSeenAt: number;
  /** Send a move (`to` is `row * 10 + col`); `spy` rides on it. Rejects with a plain message when the rollup refused it. */
  onMove: (piece: number, to: number, o?: ActionOptions) => Promise<void>;
  /** Blast, Rescue or Dig in with a piece. Each takes the turn. */
  onPower: (kind: "blast" | "rescue" | "dig_in", piece: number, o?: ActionOptions) => Promise<void>;
  onTwoStep: () => Promise<void>;
  /** The Match is over and being settled: no more taps. */
  ended?: boolean;
  /** Reads of the Battle are failing: the board may be behind. */
  reconnecting?: boolean;
  children?: ReactNode;
}

const wait = (ms: number) => new Promise<void>((ok) => setTimeout(ok, prefersReducedMotion() ? 0 : ms));
const slideMs = (a: Square, b: Square) => Math.min(380, 140 + (Math.abs(a.r - b.r) + Math.abs(a.c - b.c)) * 40);
/** A Lieutenant's jump or a General's wadi crossing is a hop: lift, arc over the squares between, land. */
const HOP_MS = 620;

/**
 * The war-room table for a chain Match. It draws what the Battle and your own Army say, from your side (the
 * Italian Player sees the board turned half way round). A plain move slides at once and is confirmed or snapped
 * back; an attack waits for the program's result, then the events the Battle recorded are played in order.
 */
export function VanguardTable({ battle, army, seat, turnSeenAt, onMove, onPower, onTwoStep, ended = false, reconnecting = false, children }: VanguardTableProps) {
  const fxKey = useRef(1);
  const side: Army = battle.usSeat === seat ? "us" : "it";
  const foe: Army = side === "us" ? "it" : "us";
  const [pieces, setPieces] = useState<ShownPiece[]>(() => shownPieces(battle, army, seat));
  const piecesRef = useRef(pieces);
  const [depots, setDepots] = useState(() => depotsFor(battle, side));
  const [fx, setFx] = useState<ShownFx[]>([]);
  const [storm, setStorm] = useState<ShownStorm | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [say, setSay] = useState("Your move. Tap a piece.");
  const [animating, setAnimating] = useState(false);
  const [catching, setCatching] = useState(false);
  const declared = useRef(false);
  const [sentAt, setSentAt] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [call, setCall] = useState<{ key: number; text: string; tone: CalloutTone } | null>(null);
  /** Become a Spy was tapped: it rides on this turn's action (a move, an attack, a power or a pass), and is dropped if the turn ends without one. */
  const [spyOn, setSpyOn] = useState(false);
  /** The General of the Army that was sent with a switch: it keeps its Spy face until your Army confirms it. */
  const [spySent, setSpySent] = useState<number | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  /** The enemy piece this screen once saw face up as a 10 (kept for the roster strip if it later shows as a Spy). */
  const [tenSeen, setTenSeen] = useState<number | null>(null);
  /** When your own Army last told its news (a Dig in, a switch): a later "you passed" line does not overwrite it. */
  const ownNote = useRef(0);
  const cursor = useRef(battle.eventSeq);
  const latest = useRef({ battle, army });
  const running = useRef(false);

  const put = useCallback((ps: ShownPiece[]) => {
    piecesRef.current = ps;
    setPieces(ps);
  }, []);
  const patch = useCallback((id: number, p: Partial<ShownPiece>) => put(piecesRef.current.map((x) => (x.id === id ? { ...x, ...p } : x))), [put]);
  const shout = useCallback((text: string, tone: CalloutTone = "plain") => setCall({ key: fxKey.current++, text, tone }), [setCall]);
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
      const occupied = (r: number, c: number) => piecesRef.current.some((p) => !p.gone && p.r === r && p.c === c);
      let line = "";
      setSelected(null);
      for (const e of events) {
        if (e.kind === "move") {
          const from = toView(e.from, side);
          const to = toView(e.to, side);
          const cur = find(e.id);
          if (mineId(e.id)) declared.current = false;
          if (cur && cur.r === to.r && cur.c === to.c) continue; // your own move, already on the board
          const hop = isHopMove(from, to, occupied);
          const ms = hop ? HOP_MS : slideMs(from, to);
          patch(e.id, { r: to.r, c: to.c, ms, hop });
          sfx(hop ? "wind" : "knock");
          await wait(ms);
          if (hop) {
            sfx("knock");
            patch(e.id, { hop: false });
          }
          if (!mineId(e.id)) line = "Your opponent moved.";
        } else if (e.kind === "attack") {
          if (mineId(e.att)) declared.current = false;
          const from = toView(e.from, side);
          const to = toView(e.to, side);
          const dr = Math.sign(to.r - from.r);
          const dc = Math.sign(to.c - from.c);
          const edge = { r: to.r - dr * 0.55, c: to.c - dc * 0.55 };
          const hop = isHopMove(from, to, occupied);
          const approach = hop ? HOP_MS : slideMs(from, edge);
          patch(e.att, { r: edge.r, c: edge.c, ms: approach, hop });
          if (hop) sfx("wind");
          await wait(approach);
          if (hop) patch(e.att, { hop: false });
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
            e.outcome === "truck" ? (mine ? "Supply Truck captured!" : "Opponent took your Truck.")
            : e.outcome === "mine" ? (mine ? `Landmine! Your ${a} is lost.` : "Opponent hit your Landmine.")
            : e.outcome === "defuse" ? (mine ? "Your Engineer cleared a Landmine." : "Opponent cleared your Landmine.")
            : e.outcome === "tie" ? `Both ${a}s fall.`
            : mine ? (attWins ? `Your ${aRank} beat their ${dRank}.` : `Your ${aRank} lost.`)
            : attWins ? `Opponent took your ${dRank}.` : `Your ${dRank} held.`;
        } else if (e.kind === "blast") {
          const mine = mineId(e.id);
          if (mine) declared.current = false;
          const cur = find(e.id);
          if (!mine && cur) {
            patch(e.id, { up: true, rank: "3", hitFrom: "top" });
            sfx("flip");
            await wait(700);
          }
          const at = toView(e.at, side);
          addFx("mine", at.r + 0.5, at.c + 0.5, 3.6);
          sfx("blast");
          shout("Engineer blast!", mine ? "plain" : "warn");
          patch(e.id, { gone: true });
          await wait(260);
          // the enemy pieces around it turn face up to the Player who was not hit; their own are shown to the enemy
          const turned = e.shown.filter((s) => !mineId(s.id) && !find(s.id)?.up);
          e.shown.forEach((s) => {
            const q = find(s.id);
            if (!q) return;
            if (mineId(s.id)) return patch(s.id, { exposed: true });
            if (q.up) return;
            const dr = Math.sign(q.r - at.r);
            const dc = Math.sign(q.c - at.c);
            patch(s.id, { up: true, rank: s.rank, hitFrom: dc > 0 ? "left" : dc < 0 ? "right" : dr > 0 ? "top" : "bottom" });
          });
          if (turned.length) sfx("flip");
          const own = e.shown.filter((s) => mineId(s.id)).length;
          line = mine ? (turned.length ? `Blast showed ${turned.length} enemy ${turned.length === 1 ? "piece" : "pieces"}.` : "Blast: nothing hidden nearby.") : `Their Blast showed ${own} of your ${own === 1 ? "piece" : "pieces"}.`;
          await wait(turned.length ? 820 : 300);
        } else if (e.kind === "rescue") {
          const mine = mineId(e.colonel);
          if (mine) declared.current = false;
          const from = toView(e.from, side);
          const to = toView(e.to, side);
          if (!mine) {
            patch(e.colonel, { up: true, rank: "8", hitFrom: "top" });
            sfx("flip");
            await wait(700);
          }
          addFx("mine", to.r + 0.5, to.c + 0.5, 2.8);
          sfx("blast");
          patch(e.colonel, { gone: true });
          await wait(300);
          addFx("dust", from.r + 0.5, from.c + 0.5, 2.4);
          sfx("wind");
          patch(e.truck, { r: to.r, c: to.c, ms: 700, fly: true, ...(mine ? {} : { up: true, rank: "F" as Rank, hitFrom: "bottom" as HitSide }) });
          shout("Truck rescued!", mine ? "plain" : "warn");
          await wait(720);
          addFx("dust", to.r + 0.5, to.c + 0.5, 2.4);
          patch(e.truck, { fly: false });
          line = mine ? "Truck rescued: it jumped to your Colonel's square." : "Their Truck was rescued. It is face up now.";
          await wait(300);
        } else if (e.kind === "dug_in") {
          // only a face-up Major's Dig in is named (F1), to both sides. A face-down one is a plain `pass` and shows nothing more.
          declared.current = false;
          patch(e.id, { rank: "B", fresh: true, ...(mineId(e.id) ? { changed: "dug" as const } : {}) });
          shout(mineId(e.id) ? "Dug in" : "Their Major dug in", mineId(e.id) ? "plain" : "warn");
          sfx("knock");
          await wait(650);
        } else if (e.kind === "pass") {
          // a face-down Dig in is a pass record. Players have no Pass button, so the opponent is told a Major dug in, never which one.
          declared.current = false;
          line = e.army === side ? "Your Major dug in." : "Their Major dug in somewhere.";
        } else if (e.kind === "switched") {
          // a face-up 10 switching is public; your own face-down one is told by your Army (below), never by a record
          if (!mineId(e.id)) {
            patch(e.id, { rank: "1", fresh: true });
            shout("Their 10 became a Spy", "warn");
            line = "Their 10 became a Spy.";
            sfx("check");
            await wait(600);
          }
        } else if (e.kind === "spotted") {
          const p = find(e.id);
          patch(e.id, { up: true, rank: "F", hitFrom: "bottom" });
          if (p) addFx("spotted", p.r + 0.5, p.c + 0.5, 2.8);
          sfx("fold");
          const own = mineId(e.id);
          shout(own ? "Your Truck is Spotted!" : "Spotted!", "warn");
          line = own ? "Your Truck is Spotted." : "Opponent's Truck is Spotted.";
          await wait(500);
        } else if (e.kind === "raid") {
          const at = toView(e.at, side);
          setDepots((ds) => ds.map((d) => (d.r === at.r && d.c === at.c ? { ...d, claimed: true } : d)));
          addFx("spotted", at.r + 0.5, at.c + 0.5, 1.7);
          sfx("check");
          shout(e.army === side ? "Two-Step Turn earned" : "They raided your depot");
          line = e.army === side ? "Depot raided: Two-Step Turn." : "Opponent raided your depot.";
          await wait(500);
        } else if (e.kind === "storm") {
          const index = side === "us" ? e.index : 9 - e.index;
          const dir = side === "us" ? e.dir : (-e.dir as 1 | -1);
          setStorm({ key: Date.now(), axis: e.axis, index, dir });
          sfx("wind");
          shout("Dust storm!", "warn");
          setSay(`Dust storm: ${e.axis === "row" ? `row ${10 - index}` : `column ${index + 1}`}.`);
          await wait(1000);
          e.shifts.forEach((s) => {
            const to = toView(s.to, side);
            patch(s.id, { r: to.r, c: to.c, ms: 1200, drift: true });
          });
          await wait(2500);
          e.shifts.forEach((s) => patch(s.id, { drift: false }));
          setStorm(null);
          line = `Storm drifted ${e.shifts.length} ${e.shifts.length === 1 ? "piece" : "pieces"}.`;
        } else if (e.kind === "turn") {
          line = turnLine(e, side, declared.current) ?? line;
          declared.current = false;
        }
      }
      const { army: mineNow } = latest.current;
      // a switch sent with the action is told by your Army (below) once it is read; until then only the 10's Spy face stands in
      setSpySent(null);
      put(shownPieces(b, mineNow, seat));
      setDepots(depotsFor(b, side));
      cursor.current = b.eventSeq;
      if (b.status === STATUS.over || b.status === STATUS.cancelled) {
        sfx(b.winner === seat ? "win" : "lose");
        setSay(endLine(b, seat));
      } else if (line && Date.now() - ownNote.current > 4000) setSay(line);
    },
    [addFx, patch, put, seat, shout, side],
  );

  // New Battle state: play what is new, or snap to the board when too far behind.
  useEffect(() => {
    latest.current = { battle, army };
    if (running.current) return;
    running.current = true;
    void (async () => {
      setAnimating(true);
      try {
        for (;;) {
          const b = latest.current.battle;
          if (b.eventSeq === cursor.current && b.status < STATUS.over) break;
          const c = catchUp(b, cursor.current);
          setCatching(c.mode === "play" && c.events.length > 2);
          if (c.mode === "snap") {
            put(shownPieces(b, latest.current.army, seat));
            setDepots(depotsFor(b, side));
            cursor.current = b.eventSeq;
          } else if (c.mode === "play" && c.events.length) await play(c.events, b);
          else {
            cursor.current = b.eventSeq;
            if (b.status >= STATUS.over) setSay(endLine(b, seat));
          }
          if (latest.current.battle === b) break;
        }
      } finally {
        running.current = false;
        setAnimating(false);
        setCatching(false);
      }
    })();
  }, [battle, army, play, put, seat, side]);

  // A sent move is pending until the turn moves on.
  const turnNow = `${battle.turnNo}:${battle.moves}:${battle.stepsLeft}`;

  // the countdown ring
  const live = battle.status === STATUS.live && !ended;
  useEffect(() => {
    if (!live) return;
    let raf = 0;
    let lastSec = -1;
    const loop = () => {
      const t = Date.now();
      setNow(t);
      const left = Math.ceil((ringStart(battle, turnSeenAt) + turnMsOf(battle) - t) / 1000);
      if (battle.turn === (side === "us" ? 0 : 1) && left <= 2 && left > 0 && left !== lastSec) sfx("tick");
      lastSec = left;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [live, battle, turnSeenAt, side]);

  const game = useMemo(() => lookGame(battle, army, seat), [battle, army, seat]);
  const pending = live ? pendingOf(battle, seat) : null;
  const yourTurn = live && !animating && !pending && sentAt !== turnNow && battle.turn === (side === "us" ? 0 : 1);
  const sel = selected === null ? null : game.pieces.find((p) => p.id === selected) ?? null;
  const power = yourTurn && sel ? powerFor(game, sel) : null;
  const marks: Mark[] = yourTurn && sel ? targets(game, sel).map((t) => ({ ...toView(t, side), attack: t.attack, jump: isJump(playedRank(game, sel), sel, t) })) : [];
  // what a power will do is drawn while its piece is selected: no extra tap
  const truck = sel && power?.kind === "rescue" ? game.pieces.find((p) => p.army === side && p.rank === "F") : undefined;
  const preview: Preview | null =
    !sel || !power?.preview ? null : power.kind === "blast" ? { kind: "blast", squares: blastSquares(sel).map((q) => toView(q, side)) } : truck ? { kind: "rescue", from: toView(truck, side), to: toView(sel, side) } : null;
  /** The General of the Army that Become a Spy would switch (or just did): shown as a Spy as soon as the button is tapped. */
  const tenId = spyOn ? game.pieces.find((p) => p.army === side && canSwitch(game, p))?.id : spySent ?? undefined;

  // Your own Army is the only place your Dig in and your switch are told: when it shows a code it did not before, say so
  // (whether the Battle or the Army reached this screen first, and whether or not the board already drew the result).
  const armyBefore = useRef(army);
  useEffect(() => {
    const before = armyBefore.current;
    armyBefore.current = army;
    const base = side === "us" ? 30 : 0;
    const fresh = Array.from({ length: 30 }, (_, i) => i).filter((i) => changeOfCode(army.ranks[i]) !== null && changeOfCode(army.ranks[i]) !== changeOfCode(before.ranks[i]));
    if (!fresh.length) return;
    fresh.forEach((i) => patch(base + i, { rank: rankOfCode(army.ranks[i]), changed: changeOfCode(army.ranks[i]) ?? undefined, fresh: true }));
    setSpySent((id) => (id !== null && fresh.some((i) => base + i === id) ? null : id));
    const dug = fresh.some((i) => changeOfCode(army.ranks[i]) === "dug");
    sfx(dug ? "knock" : "check");
    shout(dug ? "Dug in" : "Now a Spy");
    setSay(dug ? "Your Major is a Landmine now." : "Your 10 is a Spy for good.");
    ownNote.current = Date.now();
  }, [army, patch, shout, side]);

  const onPiece = (id: number) => {
    if (!yourTurn) return;
    const p = game.pieces.find((x) => x.id === id);
    if (!p || p.army !== side) return;
    if (selected === id) return setSelected(null);
    setSelected(id);
    const t = targets(game, p);
    const rank = playedRank(game, p);
    if (!t.length && !powerFor(game, p)) setSay(rank === "B" ? "Landmines never move." : rank === "F" && p.fuel >= 3 ? "Truck out of fuel." : rank === "F" ? "Truck can't move twice running." : "Nowhere to go.");
    else setSay(powerBlockedLine(game, p) || (powerFor(game, p) ? "Move it, or use its power." : canSwitch(game, p) ? "Move it, or Become a Spy first." : "Pick a marked square."));
  };

  const snapBack = useCallback(
    (message: string) => {
      put(shownPieces(latest.current.battle, latest.current.army, seat));
      setSentAt(null);
      setSelected(null);
      setSpySent(null);
      setSay(message);
    },
    [put, seat],
  );

  /** One tap sends the action; Become a Spy rides on it. What the program decides comes back as events. */
  const sent = (message: string) => {
    setSentAt(turnNow);
    setSelected(null);
    setSpySent(spyOn ? (tenId ?? null) : null);
    setSpyOn(false);
    declared.current = true;
    if (message) setSay(message);
  };
  const failed = (e: Error) => {
    declared.current = false;
    snapBack(e.message || "That did not go through.");
  };

  const onMark = (mark: Square & { attack: boolean }) => {
    if (!yourTurn || selected === null) return;
    const to = fromView(mark, side);
    const piece = selected;
    const spy = spyOn;
    const from = piecesRef.current.find((p) => p.id === piece);
    sent(mark.attack ? "Attacking…" : "");
    if (!mark.attack) {
      // a plain move slides at once (a jump hops); the program confirms it, or the piece goes back
      const hop = !!from && isHopMove(from, mark, (r, c) => piecesRef.current.some((p) => !p.gone && p.r === r && p.c === c));
      patch(piece, { r: mark.r, c: mark.c, ms: hop ? HOP_MS : slideMs(from ?? mark, mark), hop });
      sfx(hop ? "wind" : "knock");
      if (hop) setTimeout(() => patch(piece, { hop: false }), HOP_MS);
    }
    onMove(piece, indexOf(to), { spy }).catch(failed);
  };

  const pressPower = () => {
    if (!yourTurn || !sel || !power) return;
    const spy = spyOn;
    sent(power.kind === "dig_in" ? "" : `${power.label}…`);
    onPower(power.kind, sel.id, { spy }).catch(failed);
  };
  const toggleSpy = () => {
    setSpyOn(!spyOn);
    setSay(spyOn ? "Spy taken back." : "One way: it stays a Spy.");
  };
  const closeRules = useCallback(() => setRulesOpen(false), []);

  const twoStepLeft = battle.twoStep[side === "us" ? 0 : 1];
  const useTwoStep = () => {
    if (!yourTurn) return;
    setSentAt(turnNow);
    onTwoStep()
      .then(() => setSay("Two steps this turn."))
      .catch((e: Error) => snapBack(e.message || "That did not go through."));
  };

  const left = live ? ringLeft(battle, turnSeenAt, now) : 0;
  // the get-ready countdown over the opening grace; it stays up through "Go!" and goes once the first move lands
  const [readyDone, setReadyDone] = useState<string | null>(null);
  const readyLeft = live ? getReadyLeft(battle, turnSeenAt, now) : null;
  const readyKey = turnKey(battle);
  const showReady = live && readyDone !== readyKey && (readyLeft !== null || (isOpening(battle) && now - ringStart(battle, turnSeenAt) < 800));
  const plate = (a: Army) => {
    const mineP = a === side;
    const active = live && battle.turn === (a === "us" ? 0 : 1);
    const low = active && left < 0.4;
    const banked = battle.twoStep[a === "us" ? 0 : 1];
    const missed = missedLabel(battle.timeouts[a === "us" ? 0 : 1]);
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
        {missed && <span className={`vg-missed${battle.timeouts[a === "us" ? 0 : 1] >= 2 ? " last" : ""}`}>{missed}</span>}
        {!mineP && banked > 0 && <span className="vg-tok">Two-Step ×{banked}</span>}
      </div>
    );
  };

  const mineIdx = side === "us" ? 0 : 1;
  const turn: TurnInfo = {
    label: live ? (battle.turn === mineIdx ? (battle.twoStepActive ? `Two-Step · ${battle.stepsLeft} left` : "Your turn") : "Their turn") : "",
    banked: twoStepLeft,
    active: battle.twoStepActive !== 0,
    yourTurn,
    moved: battle.moved !== 0n,
    onUse: useTwoStep,
    power: power ? { label: power.label, hint: power.hint, onPress: pressPower } : null,
    spy: yourTurn && sel && canSwitch(game, sel) ? { on: spyOn, onPress: toggleSpy } : null,
  };
  // the strip counts what the Battle shows of the enemy (dead pieces included), never an event count: it holds after a ring wrap or a reload
  const seenTen = shownTen(battle, seat);
  if (seenTen !== null && seenTen !== tenSeen) setTenSeen(seenTen);
  const rv = chainRoster(battle, seat, seenTen ?? tenSeen);
  const roster = (
    <div className="vg-roster" role="list" aria-label={`${foe === "us" ? "US" : "Italian"} pieces still on the board, by rank`}>
      {rv.cells.map(({ rank, of, left: n }) => (
        <span
          key={rank}
          role="listitem"
          className={`${n === 0 ? "out" : ""}${rank === "10" && rv.tenOrSpy ? " maybe" : ""}`}
          aria-label={`${NAMES[rank]}: ${n} of ${of} left${rank === "10" && rv.tenOrSpy ? ", may be a Spy now" : ""}`}
        >
          <b>{rank}</b>
          {n}/{of}
        </span>
      ))}
      {rv.tenOrSpy && (
        <span className="vg-notes" role="note">
          <em>10 or Spy?</em>
        </span>
      )}
    </div>
  );
  const shownOnBoard = tenId === undefined ? pieces : pieces.map((p) => (p.id === tenId ? { ...p, rank: "1" as Rank, changed: "spy" as const } : p));

  return (
    <Arena game="vanguard" autoFull={!ended}>
      <VanguardScreen
        bar={
          <div className="vg-bar">
            <Label>Vanguard</Label>
            <span className="vg-bar-tools">
              <button type="button" className="cut cut-chip fx-mute" onClick={() => setRulesOpen((o) => !o)} aria-expanded={rulesOpen} aria-label="Ranks and powers" title="Ranks and powers">
                <BookOpen size={16} aria-hidden="true" />
              </button>
              <MuteToggle />
              <FullScreenToggle />
            </span>
          </div>
        }
        foe={plate(foe)}
        roster={roster}
        me={plate(side)}
        turn={turn}
        say={say}
        stage={
        <div className="vg-stage">
          <VanguardBoard pieces={shownOnBoard} depots={depots} selected={selected} marks={marks} preview={preview} fx={fx} storm={storm} locked={!yourTurn} viewer={side} onPiece={onPiece} onMark={onMark} />
          {showReady && <Countdown key={readyKey} {...START_COUNTDOWN} from={readyLeft ?? 0} className="vg-count" onEnd={() => setReadyDone(readyKey)} />}
          {rulesOpen && <RulesSheet onClose={closeRules} />}
          {call && <Callout key={call.key} text={call.text} tone={call.tone} duration={1300} onDone={() => setCall(null)} className="vg-call" />}
        </div>
        }
      >
        {reconnecting && <p className="vg-note warn" role="status">Reconnecting… the board may be a few moves behind.</p>}
        {catching && <p className="vg-note" role="status">Catching up with the moves you missed…</p>}
        {pending && <p className="vg-note" role="status">{pending.line}</p>}
        {children}
      </VanguardScreen>
    </Arena>
  );
}
