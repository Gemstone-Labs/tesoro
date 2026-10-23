"use client";

import { useEffect, useRef, useState } from "react";
import { call, check, fold, raise, type Action, type Table } from "./chain";
import { legalMoves, raisePresets } from "./rules";

const chips = (n: bigint | number) => Number(n).toLocaleString("en-US");

/**
 * Fold / Check or Call / Raise to. The raise size is one of four presets (raise by 200, 400, 600 or
 * 800 on top of the current bet) or All-in; each button says what it will do. Desktop shortcuts:
 * F fold, C check or call, R raise, A picks All-in.
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
  const max = Number(lg.maxTo);
  const presets = raisePresets(t, seat);
  // The picked size resets whenever the legal range moves (a new street or a re-raise): it starts on
  // the smallest preset that is legal, or All-in when none is.
  const range = `${lg.minTo}:${lg.maxTo}`;
  const [pick, setPick] = useState<{ range: string; by: bigint | "all" } | null>(null);
  const firstOk = presets.find((p) => p.ok);
  const chosen = pick && pick.range === range ? pick.by : (firstOk?.by ?? "all");
  const picked = chosen === "all" ? undefined : presets.find((p) => p.by === chosen && p.ok);
  const value = picked ? Number(picked.to) : max;
  const facing = lg.toCall > 0n;
  const raiseOk = enabled && lg.canRaise;
  const verb = lg.isBet ? "Bet" : "Raise";
  const allInRaise = value === max;
  const sizeLabel = lg.isBet ? "Bet" : "Raise by";

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
  const allIn = () => setPick({ range, by: "all" });
  const latest = useRef({ act, enabled, raiseOk, allIn });
  useEffect(() => {
    latest.current = { act, enabled, raiseOk, allIn };
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
      else if (k === "r" && cur.raiseOk) cur.act.raise();
      else if (k === "a" && cur.raiseOk) cur.allIn();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const passText = facing ? `Call ${chips(lg.toCall)}` : "Check";
  // The pressed button says it is sending, so the bar never grows a status line.
  const sending = busy && busy !== "claim_timeout" ? (busy.startsWith("fold") ? "fold" : busy.startsWith("check") || busy.startsWith("call") ? "pass" : "raise") : null;
  const label = (which: typeof sending, text: string) => (sending === which ? "Sending…" : text);
  const raiseText = allInRaise && raiseOk ? `All-in ${chips(value)}` : `${verb} to ${chips(value)}`;

  return (
    <div className="cut cut-frame hdx-actions" role="group" aria-label="Actions">
      <div className="hdx-btns">
        <button type="button" className={`cut cut-btn hdx-btn${sending === "fold" ? " sending" : ""}`} disabled={!enabled} onClick={act.fold}>
          <span>{label("fold", "Fold")}</span>
          <kbd aria-hidden="true">F</kbd>
        </button>
        <button type="button" className={`cut cut-btn hdx-btn primary${sending === "pass" ? " sending" : ""}`} disabled={!enabled} onClick={act.pass} aria-label={passText}>
          <span>{label("pass", passText)}</span>
          <kbd aria-hidden="true">C</kbd>
        </button>
        <button type="button" className={`cut cut-btn hdx-btn${sending === "raise" ? " sending" : ""}`} disabled={!raiseOk} onClick={act.raise} aria-label={raiseText}>
          <span>{label("raise", raiseText)}</span>
          <kbd aria-hidden="true">R</kbd>
        </button>
      </div>
      <div className="hdx-raise" id="hd-raise-ctl" role="group" aria-label={sizeLabel}>
        <span className="label">{sizeLabel}</span>
        <div className="hd-presets">
          {presets.map((p) => (
            <button
              key={String(p.by)}
              type="button"
              className="cut cut-chip hd-preset"
              aria-pressed={raiseOk && p.ok && chosen === p.by}
              disabled={!raiseOk || !p.ok}
              onClick={() => setPick({ range, by: p.by })}
            >
              {lg.isBet ? "" : "+"}
              {chips(p.by)}
            </button>
          ))}
          <button type="button" className="cut cut-chip hd-preset" aria-pressed={raiseOk && !picked} disabled={!raiseOk} onClick={allIn}>
            All-in <kbd aria-hidden="true">A</kbd>
          </button>
        </div>
      </div>
      <span className="sr-only" role="status">
        {sending ? `Sending ${busy?.split(" ")[0]}` : ""}
      </span>
    </div>
  );
}
