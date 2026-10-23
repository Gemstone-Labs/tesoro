"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Label } from "@/components/ui";
import { PHASE, STATUS, type Action } from "../chain";
import { HoldemTable } from "../HoldemTable";
import { botAction } from "./bot";
import { act, deal, holes, newPractice, type Practice } from "./engine";
import { paced } from "../pace";
import { CARD_LANDS, DEAL_MS, STREET_LEAD } from "../useTableFeed";

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
  const seen = useRef({ phase: -1, handNo: -1 });

  // Between hands: leave the last hand on the table for a moment (longer after a showdown), then deal.
  // The bot thinks for a beat before acting so its moves can be followed.
  useEffect(() => {
    if (!game || !t || t.status !== STATUS.live) return;
    const fresh = t.phase !== seen.current.phase || t.handNo !== seen.current.handNo;
    seen.current = { phase: t.phase, handNo: t.handNo };
    if (t.phase === PHASE.shuffle) {
      const pause = t.lastHand.handNo === 0 ? 400 : paced(t.lastHand.showdown ? 3900 : 2100);
      const id = setTimeout(() => setGame((g) => (g ? deal(g, nowSecs()) : g)), pause);
      return () => clearTimeout(id);
    }
    if (t.toAct === BOT) {
      // A street that was just dealt is still landing on the table: the bot waits for it like a Player would.
      const landing = !fresh ? 0 : t.phase === PHASE.preflop ? DEAL_MS : STREET_LEAD + CARD_LANDS + paced(2 * 140);
      const id = setTimeout(() => setGame((g) => (g ? act(g, BOT, botAction(g.table, BOT, holes(g)[BOT]), nowSecs()) : g)), landing + paced(700 + Math.random() * 500));
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
      <HoldemTable
        table={t}
        seat={YOU}
        hole={hole}
        busy={null}
        ended={over}
        onAct={onAct}
        onClaim={() => {}}
        practice
        endPanel={
          over && (
            <div className="cut cut-frame hd-practice-end">
              <div className="hd-end-text">
                <Label>{t.winner === YOU ? "You won" : "Bot won"}</Label>
                <p className="hd-end-chips mono">
                  You <b>{Number(t.stacks[YOU]).toLocaleString("en-US")}</b> · Bot <b>{Number(t.stacks[BOT]).toLocaleString("en-US")}</b>
                </p>
              </div>
              <div className="bp-actions">
                <Button onClick={() => setGame(newPractice(nowSecs()))}>Play again</Button>
                <Button href="/play">Play</Button>
              </div>
            </div>
          )
        }
      />
    </div>
  );
}
