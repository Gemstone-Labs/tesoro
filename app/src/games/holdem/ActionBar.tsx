"use client";

import { useEffect, useRef, useState } from "react";
import { call, check, fold, raise, type Action, type Table } from "./chain";
import { legalMoves } from "./rules";

const chips = (n: bigint | number) => Number(n).toLocaleString("en-US");

/**
 * Fold / Check or Call / Raise to, with a slider, presets and All-in. Each button says what it will
 * do. Desktop shortcuts: F fold, C check or call, R raise, A sets the raise to all-in.
 */
export function ActionBar({
  table: t,
  seat,
  enabled,
  busy,
  onAct,
}: {
  table: Table;
  seat: number;
  enabled: boolean;
  busy: string | null;
  onAct: (a: Action, label: string) => void;
}) {
  const lg = legalMoves(t, seat);
  const min = Number(lg.minTo);
  const max = Number(lg.maxTo);
  const [to, setTo] = useState<number>(min);
  const value = Math.min(max, Math.max(min, Number.isFinite(to) ? to : min));
  const facing = lg.toCall > 0n;
  const pot = Number(t.pot);
  const current = Number(t.bets[0] > t.bets[1] ? t.bets[0] : t.bets[1]);
  const raiseOk = enabled && lg.canRaise;
  const verb = lg.isBet ? "Bet" : "Raise";
  const allInRaise = value === max;
  const preset = (label: string, target: number) => (
    <button key={label} type="button" className="cut cut-chip hd-preset" disabled={!raiseOk} onClick={() => setTo(Math.min(max, Math.max(min, Math.round(target))))}>
      {label}
    </button>
  );

  const act = { fold: () => onAct(fold(), "fold"), pass: () => (facing ? onAct(call(), `call ${lg.toCall}`) : onAct(check(), "check")), raise: () => onAct(raise(value), `${verb.toLowerCase()} to ${value}`) };
  const latest = useRef({ act, enabled, raiseOk, max });
  useEffect(() => {
    latest.current = { act, enabled, raiseOk, max };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || el?.closest("input[type=number], input[type=text], textarea, select, [contenteditable]")) return;
      const cur = latest.current;
      const k = e.key.toLowerCase();
      if (!cur.enabled) return;
      if (k === "f") cur.act.fold();
      else if (k === "c") cur.act.pass();
      else if (k === "r" && cur.raiseOk) cur.act.raise();
      else if (k === "a" && cur.raiseOk) setTo(cur.max);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const passText = facing ? `Call ${chips(lg.toCall)}` : "Check";
  const raiseText = allInRaise && raiseOk ? `All-in ${chips(value)}` : `${verb} to ${chips(value)}`;

  return (
    <div className="cut cut-frame hdx-actions" role="group" aria-label="Actions">
      <div className="hdx-btns">
        <button type="button" className="cut cut-btn hdx-btn" disabled={!enabled} onClick={act.fold}>
          <span>Fold</span>
          <kbd aria-hidden="true">F</kbd>
        </button>
        <button type="button" className="cut cut-btn hdx-btn primary" disabled={!enabled} onClick={act.pass} aria-label={passText}>
          <span>{passText}</span>
          <kbd aria-hidden="true">C</kbd>
        </button>
        <button type="button" className="cut cut-btn hdx-btn" disabled={!raiseOk} onClick={act.raise} aria-label={raiseText}>
          <span>{raiseText}</span>
          <kbd aria-hidden="true">R</kbd>
        </button>
      </div>
      <div className="hdx-raise">
        <div className="hdx-raise-in">
          <label className="label" htmlFor="hd-to">
            {verb} to
          </label>
          <input
            id="hd-to"
            className="tnum mono"
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={value}
            disabled={!raiseOk}
            onChange={(e) => setTo(Number(e.target.value))}
          />
        </div>
        <div className="hdx-raise-ctl">
          <input
            className="hd-range"
            type="range"
            aria-label={`${verb} to`}
            min={min}
            max={max}
            step={1}
            value={value}
            disabled={!raiseOk || min === max}
            style={{ ["--pct" as string]: max === min ? "100%" : `${((value - min) / (max - min)) * 100}%` }}
            onChange={(e) => setTo(Number(e.target.value))}
          />
          <div className="hd-presets">
            {preset("Min", min)}
            {preset("½ pot", current + pot / 2)}
            {preset("Pot", current + pot)}
            <button type="button" className="cut cut-chip hd-preset" disabled={!raiseOk} onClick={() => setTo(max)}>
              All-in <kbd aria-hidden="true">A</kbd>
            </button>
          </div>
        </div>
      </div>
      {!enabled && busy === null && <span className="hd-hint meta">Actions unlock on your turn.</span>}
      {busy && busy !== "claim_timeout" && <span className="hd-hint meta">Sending {busy.split(" ")[0]}…</span>}
    </div>
  );
}
