"use client";

import { Suspense, useState } from "react";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { RESULT_VARIANTS, ResultVariant } from "@/components/match/ResultVariants.prototype";
import { usePathname, useRouter } from "next/navigation";
import { notFound, useSearchParams } from "next/navigation";
import { BackingSplit } from "@/components/match/BackingSplit";
import { MatchResult, type Outcome } from "@/components/match/MatchResult";
import { DEV_WALLET } from "@/lib/chain/config";
import { match } from "@/lib/chain/fixture";
import { backerDelta, matchDelta } from "@/lib/chain/ledger";
import type { ChainMatch } from "@/lib/chain/read";
import type { GameId } from "@/lib/mock";

/** DEV ONLY (NEXT_PUBLIC_DEV_WALLET=1): every Match result variant on fixtures. `?case=won|lost|draw|refunded|backed-player|backed-lost|backer-won|backer-lost|holdem-won|holdem-lost`. */
function Preview() {
  const c = useSearchParams().get("case") ?? "won";
  const game: GameId = c.startsWith("holdem") ? "holdem" : "block-puzzle";
  const won = !["lost", "backed-lost", "backer-lost", "holdem-lost"].includes(c);
  let m: ChainMatch = match(game, 1000, won, 2, [151, 42]);
  if (c === "draw" && m.session) m = { ...m, session: { ...m.session, result: "draw", scores: [88, 88] } };
  if (c === "refunded") m = { ...m, status: "refunded", session: null, winner: null };
  const asBacker = c.startsWith("backer");
  if (c.startsWith("backed") || asBacker) {
    const me = m.sides[0].player;
    m = {
      ...m,
      backing: { seat: 0, player: asBacker ? "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" : me, funder: asBacker ? me : "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", shareBps: 4000 },
      seat: asBacker ? null : 0,
      backerSeat: asBacker ? 0 : null,
    };
  }
  const outcome: Outcome = c === "refunded" ? "refunded" : c === "draw" ? "draw" : won ? "won" : "lost";
  const delta = asBacker && m.backing ? backerDelta({ ...m, backerSeat: 0, shareBps: 4000 }) : matchDelta(m);
  const fee = Math.floor(m.entry * 2 * 0.05);
  const scores: [string, string] | null =
    outcome === "refunded" ? null : game === "holdem" ? [outcome === "won" ? "Won" : "Lost", outcome === "won" ? "Lost" : "Won"] : [String(m.session?.scores[0]), String(m.session?.scores[1])];
  const props = {
      game,
      outcome,
      delta,
      entry: m.entry,
      fee,
      role: (asBacker ? "backer" : "player") as "backer" | "player",
      backed: !!m.backing,
      scores,
      playAgainHref: "/play/queue",
      split: m.backing ? <BackingSplit m={m} /> : undefined,
      players: [m.sides[0].player, m.sides[1]?.player ?? "opponent"] as [string, string],
  };
  return <ProtoHost c={c} props={props} />;
  // eslint-disable-next-line no-unreachable
  return (
    <MatchResult
      game={game}
      outcome={outcome}
      delta={delta}
      entry={m.entry}
      fee={fee}
      role={asBacker ? "backer" : "player"}
      backed={!!m.backing}
      scores={scores}
      playAgainHref="/play/queue"
      split={m.backing ? <BackingSplit m={m} /> : undefined}
    />
  );
}

/** PROTOTYPE ONLY: variant switch (?variant=), case bar (?case=) and Replay (remounts the screen). */
const CASES = ["won", "lost", "draw", "refunded", "backed-player", "backer-won", "holdem-won", "holdem-lost"];
function ProtoHost({ c, props }: { c: string; props: Parameters<typeof ResultVariant>[0] extends infer T ? Omit<T, "v"> : never }) {
  const v = usePrototypeVariant(RESULT_VARIANTS.map((x) => x.key));
  const [run, setRun] = useState(0);
  const router = useRouter();
  const path = usePathname();
  const go = (k: string) => router.replace(`${path}?case=${k}&variant=${v}`, { scroll: false });
  const bar: React.CSSProperties = { position: "fixed", left: "50%", bottom: 64, transform: "translateX(-50%)", zIndex: 9999, display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 4, padding: 6, borderRadius: 14, background: "#2a0030", font: "600 12px/1 system-ui, sans-serif", maxWidth: "94vw" };
  const b = (on: boolean): React.CSSProperties => ({ all: "unset", cursor: "pointer", padding: "6px 9px", borderRadius: 8, background: on ? "#ff3df0" : "transparent", color: on ? "#14001a" : "#ffc6f8" });
  return (
    <>
      <div key={`${v}-${c}-${run}`} style={{ paddingBottom: 110 }}>{v === "now" ? <MatchResult {...props} /> : <ResultVariant v={v} {...props} />}</div>
      {process.env.NODE_ENV !== "production" && (
        <div style={bar}>
          {CASES.map((k) => (
            <button key={k} type="button" style={b(k === c)} onClick={() => go(k)}>{k}</button>
          ))}
          <button type="button" style={{ ...b(false), color: "#fff" }} onClick={() => setRun((n) => n + 1)}>↻ Replay</button>
        </div>
      )}
      <PrototypeSwitcher variants={[...RESULT_VARIANTS]} />
    </>
  );
}

export default function ResultPreview() {
  if (!DEV_WALLET) notFound();
  return (
    <Suspense>
      <Preview />
    </Suspense>
  );
}
