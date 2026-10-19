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
  // What the Player typed, kept as text so the field can be cleared and retyped. It resets to the
  // minimum whenever the minimum moves (a re-raise). Out of range, the raise button is disabled.
  const [edit, setEdit] = useState<{ min: number; text: string } | null>(null);
  const text = edit && edit.min === min ? edit.text : String(min);
  const setTo = (n: number) => setEdit({ min, text: String(n) });
  const typed = text === "" ? NaN : Number(text);
  const inRange = Number.isInteger(typed) && typed >= min && typed <= max;
  const value = inRange ? typed : Math.min(max, Math.max(min, Number.isFinite(typed) ? typed : min));
  const facing = lg.toCall > 0n;
  const pot = Number(t.pot);
  const current = Number(t.bets[0] > t.bets[1] ? t.bets[0] : t.bets[1]);
  const raiseOk = enabled && lg.canRaise;
  const canSendRaise = raiseOk && inRange;
  const verb = lg.isBet ? "Bet" : "Raise";
  const allInRaise = value === max;
  const preset = (label: string, target: number) => (
    <button key={label} type="button" className="cut cut-chip hd-preset" disabled={!raiseOk} onClick={() => setTo(Math.min(max, Math.max(min, Math.round(target))))}>
      {label}
    </button>
  );

  // One move per turn: `busy` only arrives after the click, so a second key press or click in between is dropped.
  const sent = useRef(false);
  useEffect(() => {
    sent.current = false;
  }, [t, busy]);
  const once = (go: () => void) => () => {
    if (sent.current) return;
    sent.current = true;
    go();
  };
  const act = {
    fold: once(() => onAct(fold(), "fold")),
    pass: once(() => (facing ? onAct(call(), `call ${lg.toCall}`) : onAct(check(), "check"))),
    raise: once(() => onAct(raise(value), `${verb.toLowerCase()} to ${value}`)),
  };
  const allIn = () => setTo(max);
  // Phones pin the bar above the bottom nav, so the amount controls fold behind one button there.
  const [open, setOpen] = useState(false);
  const latest = useRef({ act, enabled, raiseOk, canSendRaise, allIn });
  useEffect(() => {
    latest.current = { act, enabled, raiseOk, canSendRaise, allIn };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || el?.closest("input:not([type=range], [type=checkbox], [type=radio]), textarea, select, [contenteditable]")) return;
      if (el?.closest("[role=dialog], [aria-modal=true], dialog") || document.querySelector("[role=dialog], [aria-modal=true], dialog[open]")) return;
      const cur = latest.current;
      const k = e.key.toLowerCase();
      if (!cur.enabled) return;
      if (k === "f") cur.act.fold();
      else if (k === "c") cur.act.pass();
      else if (k === "r" && cur.canSendRaise) cur.act.raise();
      else if (k === "a" && cur.raiseOk) cur.allIn();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const passText = facing ? `Call ${chips(lg.toCall)}` : "Check";
  const raiseText = !inRange && raiseOk ? `${verb} to ${text === "" ? "…" : chips(typed)}` : allInRaise && raiseOk ? `All-in ${chips(value)}` : `${verb} to ${chips(value)}`;

  return (
    <div className={`cut cut-frame hdx-actions${open ? " raise-open" : ""}`} role="group" aria-label="Actions">
      <div className="hdx-btns">
        <button type="button" className="cut cut-btn hdx-btn" disabled={!enabled} onClick={act.fold}>
          <span>Fold</span>
          <kbd aria-hidden="true">F</kbd>
        </button>
        <button type="button" className="cut cut-btn hdx-btn primary" disabled={!enabled} onClick={act.pass} aria-label={passText}>
          <span>{passText}</span>
          <kbd aria-hidden="true">C</kbd>
        </button>
        <button type="button" className="cut cut-btn hdx-btn" disabled={!canSendRaise} onClick={act.raise} aria-label={raiseText}>
          <span>{raiseText}</span>
          <kbd aria-hidden="true">R</kbd>
        </button>
      </div>
      <button type="button" className="cut cut-chip hd-preset hdx-more" aria-expanded={open} aria-controls="hd-raise-ctl" disabled={!raiseOk} onClick={() => setOpen((o) => !o)}>
        {open ? "Hide amount" : `Set ${verb.toLowerCase()} amount`}
      </button>
      <div className="hdx-raise" id="hd-raise-ctl">
        <div className="hdx-raise-in">
          <label className="label" htmlFor="hd-to">
            {verb} to
          </label>
          <input
            id="hd-to"
            className="tnum mono"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={text}
            disabled={!raiseOk}
            aria-invalid={raiseOk && !inRange}
            aria-describedby="hd-to-range"
            onChange={(e) => setEdit({ min, text: e.target.value.replace(/\D/g, "").slice(0, 12) })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSendRaise) act.raise();
            }}
          />
          {raiseOk && (
            <span id="hd-to-range" className={`mono hd-range-hint${inRange ? "" : " bad"}`}>
              {min === max ? `All-in only: ${chips(max)}` : `${chips(min)} to ${chips(max)}`}
            </span>
          )}
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
            <button type="button" className="cut cut-chip hd-preset" disabled={!raiseOk} onClick={allIn}>
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
