"use client";

/**
 * PROTOTYPE ONLY (branch proto/queue-page-10-10-2026). Three layouts for the Queue / Challenge wait
 * page (/play/queue), switched by `?variant=A|B|C|now`. With a variant in the URL nothing is sent on
 * chain: `?state=busy|found|signed-out|gemas|failure|existing` picks what the page shows, and
 * `?waiting=N` fakes N Players in the Queue.
 */
import Image from "next/image";
import { useEffect, useState } from "react";
import { Busy, Button, GemaAmount } from "@/components/ui";
import { PlayerAvatar } from "@/components/account/Player";
import { art } from "@/lib/art";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES, type GameId } from "@/lib/mock";
import "./queue-proto.css";

export type Phase =
  | { kind: "busy"; status: string }
  | { kind: "signed-out" }
  | { kind: "existing"; href: string }
  | { kind: "gemas"; have: number }
  | { kind: "failure"; text: string; wallet?: boolean };

export type QueueView = {
  title: string;
  mode: "queue" | "challenge-new" | "challenge-join";
  game: GameId;
  entry: number | null;
  assetName: string;
  backed: boolean;
  me: string | null;
  waiting: string[];
  opponent: string | null;
  phase: Phase;
  practice: string;
  signIn: () => void;
};

export const VARIANTS = [
  { key: "A", name: "Game stage + steps" },
  { key: "B", name: "Versus seats" },
  { key: "C", name: "Split: status + how to play" },
  { key: "now", name: "Current" },
] as const;
export type VariantKey = (typeof VARIANTS)[number]["key"];

/** The labels the real flow sends, in order: the prototype plays them back on a loop. */
export const BUSY_LOOP = [
  "Getting your wallet ready…",
  "Checking your SOL and Account…",
  "Looking for an opponent…",
  "Opening a Match…",
  "Confirming your entry on Solana…",
  "Match opened. You'll be paired while you play.",
];
export const DEMO_KEYS = ["F1826fQVH5qdcXiVwwdZAmM37SDmYECyMuoU9R1E6Tho", "EhSQcS7FTkRTY8L731n8D7kVKJFRzix9tiWvHYi3oCEU", "E7xPxMhkt4fW6YycW7LgxtJNX2XUF4U1cuaijkucyJUM", "9jy3hmgDk8mQUEx8XzDjobACAiQLmQcKxmjXen4B1gVS"];

const HERO: Record<GameId, string> = { "block-puzzle": art.blockPuzzleHero, holdem: art.holdemHero, "trading-duel": art.tradingDuelHero };
const TILE: Record<GameId, string> = { "block-puzzle": art.blockPuzzleTile, holdem: art.holdemTile, "trading-duel": art.tradingDuelTile };
const RULES: Record<GameId, string[]> = {
  "block-puzzle": ["Same pieces as your opponent", "90 seconds · higher score wins", "Pieces stay hidden until you press Start"],
  holdem: ["1,500 Chips each, blinds rise every hand", "30 seconds per action", "Last stack standing takes the Pot minus Fees"],
  "trading-duel": ["10,000 Chips each, 5 minutes on a live price", "Long or short, 1 to 20x, one position at a time", "Higher final equity takes the Pot minus Fees"],
};
const STEPS = ["Wallet", "Opponent", "Entry", "Match"];

function stepOf(status: string): number {
  if (/opened|found|Entered|Match …/i.test(status)) return 3;
  if (/Confirming/.test(status)) return 2;
  if (/opponent|Joining|Opening|Challenge/i.test(status)) return 1;
  return 0;
}

/** Async Block Puzzle opens and plays at once; the live Games start only when paired. */
function waitLine(v: QueueView): string {
  const n = v.waiting.length;
  if (v.mode !== "queue") return v.mode === "challenge-new" ? "Your link opens once the Match is ready." : "Joining your friend's Match.";
  if (n > 0) return `${n} waiting at this entry: you take the oldest seat.`;
  return v.game === "block-puzzle" ? "No one waiting yet: you play now and are paired when someone joins." : "No one waiting yet: you sit first and the Match starts when someone joins.";
}

/** The non-busy endings, shared by every variant (the variants differ in layout, not in what they offer). */
function Outcome({ v, center }: { v: QueueView; center?: boolean }) {
  const p = v.phase;
  const row = `hstack wrap${center ? " qp-center-row" : ""}`;
  if (p.kind === "signed-out")
    return (
      <>
        <p className="meta">Sign in to play a Match.</p>
        <Button variant="money" size="lg" onClick={v.signIn}>Sign in</Button>
      </>
    );
  if (p.kind === "existing")
    return (
      <>
        <p className="status" role="status">You still have a {GAME_NAMES[v.game]} Match to play. Finish it before entering another.</p>
        <div className={row}>
          <Button variant="money" href={p.href}>Continue</Button>
          <Button href="/lobby">Lobby</Button>
        </div>
      </>
    );
  if (p.kind === "gemas")
    return (
      <>
        <p className="status err" role="status">You need {fmtGemas(v.entry ?? 0)} Gemas to enter. You have {fmtGemas(p.have)}.</p>
        <div className={row}>
          <Button variant="money" href="/wallet?open=1">Get Gemas</Button>
          <Button href={v.practice}>Practice free</Button>
          <Button href="/lobby">Lobby</Button>
        </div>
      </>
    );
  if (p.kind === "failure")
    return (
      <>
        <p className="status err" role="alert">{p.text}</p>
        <div className={row}>
          {p.wallet && <Button variant="money" href="/wallet">Open Wallet</Button>}
          <Button onClick={() => window.location.reload()}>Try again</Button>
          <Button href="/lobby">Lobby</Button>
        </div>
      </>
    );
  return null;
}

function Faces({ keys, size }: { keys: string[]; size: number }) {
  const shown = keys.slice(0, 3);
  return (
    <span className="qp-faces" aria-hidden="true">
      {shown.map((k) => <PlayerAvatar key={k} account={k} size={size} />)}
      {keys.length > shown.length && <b>+{keys.length - shown.length}</b>}
    </span>
  );
}

/* ——— A: the Game's art as a stage, a four-step track, the Queue under it ——— */
function VariantA({ v }: { v: QueueView }) {
  const busy = v.phase.kind === "busy" ? v.phase.status : null;
  const at = busy ? stepOf(busy) : -1;
  return (
    <section className="cut cut-frame qa" aria-label={v.title}>
      <div className="qa-stage">
        <Image className="qa-art" src={HERO[v.game]} alt="" fill sizes="(min-width: 1024px) 720px, 100vw" priority />
        <div className="qa-stage-body">
          <span className="qa-kicker">{v.title}{v.backed ? " · Backed" : ""}</span>
          <h1 className="qa-title">{GAME_NAMES[v.game]}{v.assetName ? ` · ${v.assetName}` : ""}</h1>
        </div>
      </div>
      <div className="qa-body">
        {v.entry !== null && (
          <dl className="qa-money">
            <div><dt>Entry</dt><dd><GemaAmount value={v.entry} size="lg" /></dd></div>
            <div><dt>Pot</dt><dd><GemaAmount value={v.entry * 2} size="lg" /><small>minus Fees</small></dd></div>
          </dl>
        )}
        {busy ? (
          <>
            <ol className="qa-steps" aria-label="Progress">
              {STEPS.map((s, i) => (
                <li key={s} className={i < at ? "done" : i === at ? "now" : ""}>
                  <span className="qa-dot" aria-hidden="true">{i < at ? "✓" : i === at ? <span className="spinner" /> : null}</span>
                  {s}
                </li>
              ))}
            </ol>
            <p className="qa-status" role="status">{busy}</p>
            {v.mode === "queue" && (
              <div className="cut qa-queue">
                {v.waiting.length > 0 ? <Faces keys={v.waiting} size={28} /> : <span className="qa-queue-empty" aria-hidden="true" />}
                <span>{waitLine(v)}</span>
              </div>
            )}
          </>
        ) : (
          <div className="stack"><Outcome v={v} /></div>
        )}
      </div>
    </section>
  );
}

/* ——— B: two seats facing each other, the Pot between them ——— */
function VariantB({ v }: { v: QueueView }) {
  const busy = v.phase.kind === "busy" ? v.phase.status : null;
  const [face, setFace] = useState(0);
  useEffect(() => {
    if (v.opponent || v.waiting.length < 2) return;
    const t = setInterval(() => setFace((f) => f + 1), 900);
    return () => clearInterval(t);
  }, [v.opponent, v.waiting.length]);
  const them = v.opponent ?? (v.waiting.length ? v.waiting[face % v.waiting.length] : null);
  return (
    <section className="qb" aria-label={v.title}>
      <header className="qb-head">
        <span className="qb-kicker">{GAME_NAMES[v.game]}{v.assetName ? ` · ${v.assetName}` : ""}{v.backed ? " · Backed" : ""}</span>
        <h1 className="qb-title">{v.opponent ? "Opponent found" : v.title}</h1>
      </header>
      <div className="qb-arena">
        <figure className="qb-seat">
          <span className="cut cut-btn qb-av">{v.me ? <PlayerAvatar account={v.me} size={112} /> : <span className="qb-q">?</span>}</span>
          <figcaption>You</figcaption>
        </figure>
        <div className="qb-pot">
          {v.entry !== null ? (
            <div className="cut cut-card qb-plaque">
              <span className="qb-label">Pot</span>
              <GemaAmount value={v.entry * 2} size="lg" />
              <small>{fmtGemas(v.entry)} each · minus Fees</small>
            </div>
          ) : (
            <span className="qb-vs">VS</span>
          )}
        </div>
        <figure className={`qb-seat${v.opponent ? "" : " seeking"}`}>
          <span className="cut cut-btn qb-av">
            {them ? <PlayerAvatar key={them} account={them} size={112} /> : <span className="qb-q">?</span>}
          </span>
          <figcaption>{v.opponent ? "Opponent" : v.waiting.length ? `${v.waiting.length} waiting` : "Open seat"}</figcaption>
        </figure>
      </div>
      <div className="qb-foot">
        {busy ? (
          <>
            <Busy>{busy}</Busy>
            {!v.opponent && <p className="meta">{waitLine(v)}</p>}
          </>
        ) : (
          <Outcome v={v} center />
        )}
      </div>
    </section>
  );
}

/* ——— C: tile art beside a big status, how to play while you wait ——— */
function VariantC({ v }: { v: QueueView }) {
  const busy = v.phase.kind === "busy" ? v.phase.status : null;
  return (
    <section className="cut cut-frame qc" aria-label={v.title}>
      <div className="qc-art">
        <Image src={TILE[v.game]} alt="" fill sizes="(min-width: 900px) 420px, 100vw" priority />
        <span className="qc-name">{GAME_NAMES[v.game]}</span>
      </div>
      <div className="qc-body">
        <span className="qc-kicker">{v.title}{v.assetName ? ` · ${v.assetName}` : ""}{v.backed ? " · Backed" : ""}</span>
        {busy ? (
          <div className="qc-now" role="status">
            <span className="qc-ring" aria-hidden="true" />
            <h1 className="qc-status">{busy.replace(/…$/, "")}</h1>
          </div>
        ) : (
          <h1 className="qc-status">{v.phase.kind === "signed-out" ? "Sign in to play" : v.phase.kind === "existing" ? "Finish your Match" : v.phase.kind === "gemas" ? "Not enough Gemas" : "Something went wrong"}</h1>
        )}
        {v.entry !== null && (
          <p className="qc-line">
            <GemaAmount value={v.entry} /> <span className="meta">entry · Pot {fmtGemas(v.entry * 2)} minus Fees</span>
          </p>
        )}
        {busy ? (
          <>
            {v.mode === "queue" && <p className="meta qc-wait">{v.waiting.length > 0 && <Faces keys={v.waiting} size={22} />}{waitLine(v)}</p>}
            <div className="qc-rules">
              <span className="qc-rules-h">While you wait</span>
              <ol>{RULES[v.game].map((r) => <li key={r}>{r}</li>)}</ol>
            </div>
          </>
        ) : (
          <div className="stack"><Outcome v={v} /></div>
        )}
      </div>
    </section>
  );
}

export function QueueVariant({ variant, v }: { variant: Exclude<VariantKey, "now">; v: QueueView }) {
  return (
    <>
      {variant === "A" && <VariantA v={v} />}
      {variant === "B" && <VariantB v={v} />}
      {variant === "C" && <VariantC v={v} />}
      <pre className="qp-state">{JSON.stringify({ phase: v.phase, waiting: v.waiting.length, opponent: v.opponent ? "yes" : null }, null, 1)}</pre>
    </>
  );
}
