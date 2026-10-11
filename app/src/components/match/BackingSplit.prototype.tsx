"use client";

/**
 * PROTOTYPE ONLY (branch proto/backing-split-11-10-2026). Four takes on the Backing split under a
 * backed Match result, switched by `?variant=now|A|B|C|D`:
 *   A Pot split  — the Pot drawn to scale, as on the How Backing works card
 *   B Two seats  — Player and Backer face to face, the Pot between them
 *   C Receipt    — the payout in the program's order, the Pot shrinking step by step
 *   D Tiles      — two figures in the result's tile style, the arithmetic behind a disclosure
 * The winner gets rewritten into BackingSplit.tsx; this file never lands on main.
 */
import { ChevronDown } from "lucide-react";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { GemaMark } from "@/components/ui";
import { backedSplit } from "@/lib/chain/ledger";
import type { ChainMatch } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";
import "./backing-split.prototype.css";

export const SPLIT_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Pot split" },
  { key: "B", name: "Two seats" },
  { key: "C", name: "Receipt" },
  { key: "D", name: "Tiles" },
] as const;
export type SplitVariant = (typeof SPLIT_VARIANTS)[number]["key"];

type Css = React.CSSProperties & Record<`--${string}`, string | number>;

function model(m: ChainMatch) {
  const b = m.backing!;
  const result = m.session ? m.session.result : m.winner;
  const asPlayer = m.seat !== null;
  const kind: "won" | "lost" | "back" = m.status === "refunded" || !result || result === "draw" ? "back" : (result === "opener") === (b.seat === 0) ? "won" : "lost";
  const s = backedSplit({ entry: m.entry, ...m.fees, shareBps: b.shareBps, won: kind === "won" });
  const share = b.shareBps / 100;
  return { b, asPlayer, kind, s, share, backerShare: 100 - share, entry: m.entry, pot: m.entry * 2 };
}
type Model = ReturnType<typeof model>;

function G({ n, sign = false, size = 14, cls = "" }: { n: number; sign?: boolean; size?: number; cls?: string }) {
  return (
    <b className={`bsp-n tnum ${cls}`}>
      {n !== 0 && n > 0 && <GemaMark size={size} />}
      {sign && n > 0 ? "+" : sign && n < 0 ? "−" : ""}
      {fmtGemas(Math.abs(n))}
    </b>
  );
}

function Who({ account, you, link }: { account: string; you: boolean; link?: boolean }) {
  if (you) return <>You</>;
  return link ? <AccountLink account={account} /> : <PlayerName account={account} />;
}

function Heading({ x }: { x: Model }) {
  const { b, asPlayer } = x;
  return (
    <span className="bsp-kicker">
      {asPlayer ? <>Backed by <PlayerName account={b.funder} /></> : <>You backed <AccountLink account={b.player} /></>}
      <span className="bsp-pill">{x.share}% to the Player</span>
    </span>
  );
}

/* ───────────────────────── A · Pot split ───────────────────────── */

function VariantA({ x }: { x: Model }) {
  const { s, asPlayer, kind } = x;
  const segs =
    kind === "won"
      ? [
          { k: "back", label: asPlayer ? "Backer's entry back" : "Your entry back", n: s.backerEntryBack, you: !asPlayer },
          { k: "backer", label: asPlayer ? `Backer's share (${x.backerShare}%)` : `Your share (${x.backerShare}%)`, n: s.backerSurplus, you: !asPlayer },
          { k: "player", label: asPlayer ? `Your share (${x.share}%)` : `Player's share (${x.share}%)`, n: s.playerShare, you: asPlayer },
          { k: "fees", label: "Fees", n: s.fees, you: false },
        ]
      : kind === "lost"
        ? [
            { k: "lost", label: asPlayer ? "Backer's entry, to the winner" : "Your entry, to the winner", n: x.entry, you: !asPlayer },
            { k: "opp", label: asPlayer ? "You lose nothing" : "The Player loses nothing", n: 0, you: asPlayer },
          ]
        : [{ k: "back", label: asPlayer ? "Entry back to your Backer" : "Your entry back", n: x.entry, you: !asPlayer }];
  const total = kind === "won" ? x.pot : x.entry;
  return (
    <section className="cut cut-card bsp bsp-a" aria-label="Backing">
      <header className="bsp-a-h">
        <Heading x={x} />
        <span className="meta">
          {kind === "won" ? <>The Pot <G n={x.pot} /></> : kind === "lost" ? "The Pot went to the opponent" : "No result: the entry went back"}
        </span>
      </header>
      <div className={`bsp-a-bar ${kind}`} role="img" aria-label={segs.map((g) => `${g.label}: ${fmtGemas(g.n)} Gemas`).join(", ")}>
        {segs.map((g, i) => (
          <i key={g.k} className={`${g.k}${g.you ? " you" : ""}`} style={{ flexGrow: g.n || total * 0.18, "--i": i } as Css} />
        ))}
      </div>
      <ul className="bsp-a-legend">
        {segs.map((g) => (
          <li key={g.k} className={`${g.k}${g.you ? " you" : ""}`} style={{ flexGrow: g.n || total * 0.18 }}>
            <span className="bsp-sw" />
            <span>{g.label}{g.you && <em>You</em>}</span>
            <G n={g.k === "lost" ? -g.n : g.n} sign={g.k !== "back" && g.k !== "fees"} cls={g.k === "lost" ? "neg" : ""} />
          </li>
        ))}
      </ul>
      <p className="bsp-note">
        {asPlayer ? "You never owe anything and never take on Debt: the Backer's Gemas funded this entry." : "Only the Backer bears a loss. The Player can never redeem or redirect your Gemas."}
      </p>
    </section>
  );
}

/* ───────────────────────── B · Two seats ───────────────────────── */

function Seat({ account, role, you, net, line, tone }: { account: string; role: string; you: boolean; net: number; line: React.ReactNode; tone: "won" | "lost" | "zero" }) {
  return (
    <div className={`cut cut-card bsp-seat ${tone}${you ? " you" : ""}`}>
      <div className="bsp-seat-who">
        <PlayerAvatar account={account} size={56} className="bsp-av" />
        <div>
          <span className="bsp-role">{role}{you && <em>You</em>}</span>
          <b className="bsp-name"><Who account={account} you={false} link={role === "Player"} /></b>
        </div>
      </div>
      <span className={`bsp-seat-net ${tone}`}>
        {tone === "won" && <GemaMark size={30} />}
        {net > 0 ? "+" : net < 0 ? "−" : ""}
        {fmtGemas(Math.abs(net))}
      </span>
      <span className="bsp-seat-line">{line}</span>
    </div>
  );
}

function VariantB({ x }: { x: Model }) {
  const { b, s, asPlayer, kind } = x;
  const player =
    kind === "won"
      ? { net: s.playerShare, tone: "won" as const, line: <>{x.share}% of the <G n={s.surplus} /> left after Fees</> }
      : { net: 0, tone: "zero" as const, line: kind === "lost" ? "Owes nothing · no Debt" : "Nothing in or out" };
  const backer =
    kind === "won"
      ? { net: s.backerSurplus, tone: "won" as const, line: <>Entry <G n={s.backerEntryBack} /> back, then {x.backerShare}%</> }
      : kind === "lost"
        ? { net: -x.entry, tone: "lost" as const, line: "Funded the entry and bore the loss" }
        : { net: 0, tone: "zero" as const, line: <>Entry <G n={x.entry} /> back</> };
  return (
    <section className="bsp bsp-b" aria-label="Backing">
      <header className="bsp-b-h"><span className="bsp-kicker">Backing</span></header>
      <div className="bsp-b-arena">
        <Seat account={b.player} role="Player" you={asPlayer} {...player} />
        <div className={`bsp-pot ${kind}`}>
          <span className="bsp-pot-flow l" aria-hidden="true" />
          <div className="cut bsp-pot-plaque">
            <span>{kind === "back" ? "Refunded" : "Pot"}</span>
            <b className="tnum"><GemaMark size={18} />{fmtGemas(kind === "back" ? x.entry : x.pot)}</b>
            <small>{kind === "won" ? <>Fees {fmtGemas(s.fees)} · split {x.share}/{x.backerShare}</> : kind === "lost" ? "to the opponent" : "no result"}</small>
          </div>
          <span className="bsp-pot-flow r" aria-hidden="true" />
        </div>
        <Seat account={b.funder} role="Backer" you={!asPlayer} {...backer} />
      </div>
      <p className="bsp-note center">
        {asPlayer ? "Your Backer's Gemas paid the entry. You never owe anything, win or lose." : "Only the Backer bears a loss. The Player never gains Debt and cannot touch your Gemas."}
      </p>
    </section>
  );
}

/* ───────────────────────── C · Receipt ───────────────────────── */

function VariantC({ x }: { x: Model }) {
  const { s, asPlayer, kind, b } = x;
  type Step = { t: React.ReactNode; to?: React.ReactNode; n: number; left: number; k: string; you?: boolean };
  const steps: Step[] =
    kind === "won"
      ? [
          { k: "pot", t: "Both entries make the Pot", n: x.pot, left: x.pot },
          { k: "fees", t: "Fees", to: "Platform, Studio, Leaderboard", n: -s.fees, left: x.pot - s.fees },
          { k: "back", t: "Backer's entry back first", to: <Who account={b.funder} you={!asPlayer} />, n: -s.backerEntryBack, left: s.surplus, you: !asPlayer },
          { k: "player", t: `Player's share · ${x.share}%`, to: <Who account={b.player} you={asPlayer} link />, n: -s.playerShare, left: s.backerSurplus, you: asPlayer },
          { k: "backer", t: `Backer's share · ${x.backerShare}%`, to: <Who account={b.funder} you={!asPlayer} />, n: -s.backerSurplus, left: 0, you: !asPlayer },
        ]
      : kind === "lost"
        ? [
            { k: "pot", t: "The Backer paid the entry", to: <Who account={b.funder} you={!asPlayer} />, n: x.entry, left: x.entry, you: !asPlayer },
            { k: "lost", t: "The opponent won the Pot", to: "Opponent", n: -x.entry, left: 0 },
            { k: "zero", t: "The Player owes", to: <Who account={b.player} you={asPlayer} link />, n: 0, left: 0, you: asPlayer },
          ]
        : [
            { k: "pot", t: "The Backer paid the entry", to: <Who account={b.funder} you={!asPlayer} />, n: x.entry, left: x.entry, you: !asPlayer },
            { k: "back", t: "No result: the entry went back", to: <Who account={b.funder} you={!asPlayer} />, n: -x.entry, left: 0, you: !asPlayer },
          ];
  const top = steps[0].n || 1;
  return (
    <section className={`cut cut-card bsp bsp-c ${kind}`} aria-label="Backing">
      <header className="bsp-c-h">
        <Heading x={x} />
        <span className="meta">How the Pot was paid out</span>
      </header>
      <ol className="bsp-c-steps">
        {steps.map((st, i) => (
          <li key={st.k} className={`${st.k}${st.you ? " you" : ""}`} style={{ "--i": i } as Css}>
            <span className="bsp-c-dot">{i + 1}</span>
            <div className="bsp-c-copy">
              <b>{st.t}{st.you && <em>You</em>}</b>
              {st.to && <span className="meta">{st.k === "pot" ? "from " : st.k === "zero" ? "" : "to "}{st.to}</span>}
            </div>
            <div className="bsp-c-track" aria-hidden="true">
              <i className="left" style={{ width: `${(st.left / top) * 100}%` }} />
              {i > 0 && st.n < 0 && <i className="out" style={{ width: `${(-st.n / top) * 100}%`, left: `${(st.left / top) * 100}%` }} />}
            </div>
            <span className="bsp-c-amt">
              {st.k === "zero" ? <b className="bsp-n tnum">0 · no Debt</b> : <G n={st.k === "lost" ? st.n : i === 0 ? st.n : -st.n} sign={st.k === "lost"} cls={st.k === "lost" ? "neg" : ""} />}
            </span>
          </li>
        ))}
      </ol>
      {kind === "won" && (
        <p className="bsp-c-total">
          <span>{asPlayer ? "You keep" : "You get back"}</span>
          <G n={asPlayer ? s.playerShare : s.backerEntryBack + s.backerSurplus} size={18} />
          {!asPlayer && <span className="meta">profit <G n={s.backerSurplus} sign /></span>}
        </p>
      )}
    </section>
  );
}

/* ───────────────────────── D · Tiles ───────────────────────── */

function VariantD({ x }: { x: Model }) {
  const { b, s, asPlayer, kind } = x;
  const you = asPlayer ? (kind === "won" ? s.playerShare : 0) : kind === "won" ? s.backerSurplus : kind === "lost" ? -x.entry : 0;
  const them = asPlayer ? (kind === "won" ? s.backerSurplus : kind === "lost" ? -x.entry : 0) : kind === "won" ? s.playerShare : 0;
  const tone = (n: number) => (n > 0 ? "won" : n < 0 ? "lost" : "");
  return (
    <section className="bsp bsp-d" aria-label="Backing">
      <div className="bsp-d-row">
        <div className="cut cut-card bsp-d-who">
          <PlayerAvatar account={asPlayer ? b.funder : b.player} size={44} className="bsp-av" />
          <div>
            <span>{asPlayer ? "Backed by" : "You backed"}</span>
            <b>{asPlayer ? <PlayerName account={b.funder} /> : <AccountLink account={b.player} />}</b>
          </div>
          <span className="bsp-pill">{x.share} / {x.backerShare}</span>
        </div>
        <div className={`cut cut-card bsp-d-tile ${tone(you)}`}>
          <span>{asPlayer ? "Your share" : kind === "won" ? "Your profit" : "You"}</span>
          <b>{you > 0 && <GemaMark size={22} />}{you > 0 ? "+" : you < 0 ? "−" : ""}{fmtGemas(Math.abs(you))}</b>
          <small>{asPlayer ? (kind === "won" ? "Yours to keep" : "Owe nothing · no Debt") : kind === "won" ? <>plus your {fmtGemas(s.backerEntryBack)} entry back</> : kind === "lost" ? "Your entry went to the winner" : "Entry back"}</small>
        </div>
        <div className={`cut cut-card bsp-d-tile ${tone(them)}`}>
          <span>{asPlayer ? "Your Backer" : "The Player"}</span>
          <b>{them > 0 && <GemaMark size={22} />}{them > 0 ? "+" : them < 0 ? "−" : ""}{fmtGemas(Math.abs(them))}</b>
          <small>{asPlayer ? (kind === "won" ? <>plus their {fmtGemas(s.backerEntryBack)} entry back</> : kind === "lost" ? "Bore the loss" : "Entry back") : kind === "won" ? `Their ${x.share}% share` : "Owes nothing · no Debt"}</small>
        </div>
      </div>
      {kind !== "back" && (
        <details className="bsp-d-more">
          <summary>How the Pot was split <ChevronDown aria-hidden="true" /></summary>
          <dl>
            {kind === "won" ? (
              <>
                <dt>Pot</dt><dd><G n={x.pot} /></dd>
                <dt>Fees</dt><dd>−{fmtGemas(s.fees)}</dd>
                <dt>Backer&apos;s entry back first</dt><dd>−{fmtGemas(s.backerEntryBack)}</dd>
                <dt>Left to split</dt><dd>{fmtGemas(s.surplus)}</dd>
                <dt>Player {x.share}%</dt><dd>{fmtGemas(s.playerShare)}</dd>
                <dt>Backer {x.backerShare}%</dt><dd>{fmtGemas(s.backerSurplus)}</dd>
              </>
            ) : (
              <>
                <dt>Backer&apos;s entry</dt><dd>{fmtGemas(x.entry)}</dd>
                <dt>Went to</dt><dd>the opponent</dd>
                <dt>Player owes</dt><dd>0 Gemas · 0 Debt</dd>
              </>
            )}
          </dl>
        </details>
      )}
    </section>
  );
}

export function BackingSplitPrototype({ m, variant }: { m: ChainMatch; variant: Exclude<SplitVariant, "now"> }) {
  const x = model(m);
  if (variant === "A") return <VariantA x={x} />;
  if (variant === "B") return <VariantB x={x} />;
  if (variant === "C") return <VariantC x={x} />;
  return <VariantD x={x} />;
}
