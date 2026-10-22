"use client";

import { useEffect, useMemo, useState } from "react";
import { getVanguard } from "@/lib/chain/client";
import type { ChainMatch } from "@/lib/chain/read";
import { STATUS, type Battle } from "./decode";
import { VanguardBoard } from "./VanguardBoard";
import { readPublicBattle, publicConnection, spectatorPieces } from "./spectate";
import { depotsFor, piecesLeft } from "./view";
import "./vanguard.css";

const POLL_MS = 2500;

/**
 * Anyone's view of a Vanguard Match: the public Battle, read with no wallet and no token, so every piece is face
 * down unless the Battle published its rank. It never asks for an Army. A finished Match reads the committed
 * Battle from the base layer, where the end reveal has turned every remaining piece face up.
 */
export function VanguardSpectate({ m }: { m: ChainMatch }) {
  const [battle, setBattle] = useState<Battle | null>(null);
  const [hidden, setHidden] = useState(false);
  const finished = m.status === "settled" || m.status === "refunded";

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const conn = publicConnection();
    const read = async () => {
      try {
        const b = finished ? await getVanguard().readBattleOnBase(m.address) : await readPublicBattle(conn, m.address);
        if (!live) return;
        setBattle(b);
        setHidden(!b);
      } catch {
        if (live) setHidden(true);
      }
      if (live && !finished) timer = setTimeout(read, POLL_MS);
    };
    if (m.status === "active" || finished) void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [m.id, m.address, m.status, finished]);

  if (m.status === "open") return null;
  return <VanguardSpectateView battle={battle} hidden={hidden} />;
}

/** The read-only board for a public Battle (or the reason there is none). */
export function VanguardSpectateView({ battle, hidden = false }: { battle: Battle | null; hidden?: boolean }) {
  const pieces = useMemo(() => (battle ? spectatorPieces(battle) : []), [battle]);
  const depots = useMemo(() => (battle ? depotsFor(battle, "us") : []), [battle]);
  if (!battle || hidden) return <p className="mr-copy">{hidden ? "In progress. The board is not readable right now." : "Loading the board…"}</p>;

  const turn = battle.turn === 0 ? "US Army" : "Royal Italian Army";
  const line = battle.status === STATUS.live ? `${turn} to move · move ${battle.moves}` : battle.status === STATUS.setup ? "Drawing the armies in secret" : "Finished";
  return (
    <section className="vg-spectate" aria-label="Vanguard board">
      <p className="mr-copy" role="status">
        {line} · US Army {piecesLeft(battle, "us")} of 20 · Royal Italian Army {piecesLeft(battle, "it")} of 20.{battle.status === STATUS.live || battle.status === STATUS.setup ? " Ranks stay hidden until a piece leaves the board." : ""}
      </p>
      <VanguardBoard pieces={pieces} depots={depots} selected={null} marks={[]} fx={[]} storm={null} locked viewer="us" onPiece={() => undefined} onMark={() => undefined} />
    </section>
  );
}
