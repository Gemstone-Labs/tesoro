"use client";

import { useEffect, useState } from "react";
import { Button, Label } from "@/components/ui";
import { PHASE, STATUS, type Action } from "../chain";
import { HoldemTable } from "../HoldemTable";
import { botAction } from "./bot";
import { act, deal, holes, newPractice, type Practice } from "./engine";

const YOU = 0;
const BOT = 1;
const nowSecs = () => Math.floor(Date.now() / 1000);

/**
 * Hold'em practice: the real table against a local bot, nothing staked, no wallet, no chain.
 * Same rules and turbo blinds as a Match; no turn clock.
 */
export function HoldemPractice() {
  // Shuffling on the server would mismatch hydration: the Match starts on mount.
  const [game, setGame] = useState<Practice | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setGame(newPractice(nowSecs())), 0);
    return () => clearTimeout(t);
  }, []);

  const t = game?.table;
  const over = t?.status === STATUS.over;

  // Between hands: leave the last hand on the table for a moment (longer after a showdown), then deal.
  // The bot thinks for a beat before acting so its moves can be followed.
  useEffect(() => {
    if (!game || !t || t.status !== STATUS.live) return;
    if (t.phase === PHASE.shuffle) {
      const pause = t.lastHand.handNo === 0 ? 400 : t.lastHand.showdown ? 3200 : 1800;
      const id = setTimeout(() => setGame((g) => (g ? deal(g, nowSecs()) : g)), pause);
      return () => clearTimeout(id);
    }
    if (t.toAct === BOT) {
      const id = setTimeout(() => setGame((g) => (g ? act(g, BOT, botAction(g.table, BOT, holes(g)[BOT]), nowSecs()) : g)), 600 + Math.random() * 400);
      return () => clearTimeout(id);
    }
  }, [game, t]);

  if (!game || !t) return <p className="meta" role="status">Shuffling…</p>;

  const dealt = t.phase >= PHASE.preflop && t.phase <= PHASE.river;
  const hole = game.lastHoles ? { handNo: dealt ? t.handNo : t.lastHand.handNo, cards: game.lastHoles[YOU] } : null;

  const onAct = (a: Action) => {
    setGame((g) => (g && g.table.toAct === YOU && g.table.status === STATUS.live ? act(g, YOU, a, nowSecs()) : g));
  };

  return (
    <div className="stack-lg">
      {over && (
        <div className="cut cut-frame hd-practice-end" role="dialog" aria-label="Practice over">
          <div>
            <Label>{t.winner === YOU ? "You won the practice Match" : "The bot won the practice Match"}</Label>
            <p className="note">Practice: nothing was staked and no Gemas moved.</p>
          </div>
          <div className="bp-actions">
            <Button onClick={() => setGame(newPractice(nowSecs()))}>Play again</Button>
            <Button href="/">Lobby</Button>
          </div>
        </div>
      )}
      <HoldemTable table={t} seat={YOU} hole={hole} busy={null} ended={over} onAct={onAct} onClaim={() => {}} practice />
      {!over && <p className="note hd-note">Practice · nothing staked · heads-up against a bot, turbo blinds rising every hand, no turn clock.</p>}
    </div>
  );
}
