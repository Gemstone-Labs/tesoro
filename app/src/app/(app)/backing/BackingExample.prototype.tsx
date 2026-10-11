"use client";

/**
 * PROTOTYPE ONLY (branch proto/backing-example-11-10-2026). Four takes on the "How Backing works"
 * card, switched by ?variant=now|A|B|C|D. The winner gets rewritten into BackingExample.tsx.
 */
import { useState } from "react";
import { Bust, Button, GemaAmount, GemaMark } from "@/components/ui";
import { CheckIcon, XIcon } from "@/components/ui/icons";
import { backedSplit } from "@/lib/chain/ledger";
import { LEADERBOARD_BPS } from "@/lib/chain/season";
import { fmtGemas } from "@/lib/format";
import "./backing-example.prototype.css";

const EX = { entry: 1000, platformBps: 200, studioBps: 300, leaderboardBps: LEADERBOARD_BPS, shareBps: 5000 };
const win = backedSplit({ ...EX, won: true });
const pct = EX.shareBps / 100;

function G({ n, sign = false }: { n: number; sign?: boolean }) {
  return (
    <b className="tnum bxp-n">
      <GemaMark size={14} />
      {sign && n > 0 ? "+" : sign && n < 0 ? "−" : ""}
      {fmtGemas(Math.abs(n))}
    </b>
  );
}

/* ——— A · Pot split: where every Gema of the Pot goes, drawn to scale ——— */
export function VariantA({ onPost }: { onPost: () => void }) {
  const pot = EX.entry * 2;
  const segs = [
    { k: "back", label: "Your entry back", n: win.backerEntryBack },
    { k: "you", label: `Your share (${100 - pct}%)`, n: win.backerSurplus },
    { k: "player", label: `Player’s share (${pct}%)`, n: win.playerShare },
    { k: "fees", label: "Fees", n: win.fees },
  ];
  return (
    <section className="cut cut-card bk-span bxa" aria-labelledby="bxa-h">
      <header className="bxa-head">
        <div>
          <h2 id="bxa-h" className="h-section">How Backing works</h2>
          <p>You pay a Player’s whole entry. If they win, the Pot pays you first. Example: a <G n={EX.entry} /> Match, Player keeps {pct}%.</p>
        </div>
        <Button variant="money" onClick={onPost}>Post a Request</Button>
      </header>
      <div className="bxa-lane">
        <div className="bxa-lane-h"><span className="bxa-ico won"><CheckIcon /></span><b>Player wins</b><span className="meta">Pot <G n={pot} /></span></div>
        <div className="bxa-bar" role="img" aria-label={segs.map((s) => `${s.label} ${fmtGemas(s.n)}`).join(", ")}>
          {segs.map((s) => <i key={s.k} className={s.k} style={{ flexGrow: s.n }} />)}
        </div>
        <ul className="bxa-legend">
          {segs.map((s) => (
            <li key={s.k} className={s.k} style={{ flexGrow: s.n }}><span className="sw" />{s.label}<G n={s.n} /></li>
          ))}
        </ul>
      </div>
      <div className="bxa-lane">
        <div className="bxa-lane-h"><span className="bxa-ico lost"><XIcon /></span><b>Player loses</b><span className="meta">Pot goes to the opponent</span></div>
        <div className="bxa-bar"><i className="lost" style={{ flexGrow: 1 }} /><i className="opp" style={{ flexGrow: 1 }} /></div>
        <ul className="bxa-legend">
          <li className="lost" style={{ flexGrow: 1 }}><span className="sw" />You lose your entry<G n={-EX.entry} sign /></li>
          <li className="opp" style={{ flexGrow: 1 }}><span className="sw" />The Player loses nothing<G n={0} /></li>
        </ul>
      </div>
    </section>
  );
}

/* ——— B · Try it: pick the outcome and the Player's share, both sides update ——— */
export function VariantB({ onPost }: { onPost: () => void }) {
  const [won, setWon] = useState(true);
  const [share, setShare] = useState(EX.shareBps);
  const s = backedSplit({ ...EX, shareBps: share, won });
  const you = won ? s.backerSurplus : s.backerNet;
  return (
    <section className="cut cut-card bk-span bxb" aria-labelledby="bxb-h">
      <div className="bxb-lead">
        <h2 id="bxb-h" className="h-section">How Backing works</h2>
        <p>A Backer pays a Player’s whole entry and takes the risk. If the Player wins, the Backer gets the entry back and they split what’s left. Try a <G n={EX.entry} /> Match.</p>
        <Button variant="money" onClick={onPost}>Post a Request</Button>
      </div>
      <div className="bxb-sim">
        <div className="bxb-seg" role="radiogroup" aria-label="Outcome">
          <button type="button" role="radio" aria-checked={won} className={won ? "on" : ""} onClick={() => setWon(true)}><CheckIcon /> Player wins</button>
          <button type="button" role="radio" aria-checked={!won} className={!won ? "on" : ""} onClick={() => setWon(false)}><XIcon /> Player loses</button>
        </div>
        <label className="bxb-share">
          <span>Player keeps</span>
          <input type="range" min={0} max={10000} step={1000} value={share} onChange={(e) => setShare(Number(e.target.value))} />
          <b className="tnum">{share / 100}%</b>
        </label>
        <div className="bxb-sides">
          <div className={`bxb-side ${you < 0 ? "neg" : "pos"}`}>
            <span className="label">You, the Backer</span>
            <b className="bxb-fig tnum">{you > 0 ? "+" : you < 0 ? "−" : ""}{fmtGemas(Math.abs(you))}</b>
            <span className="meta">{won ? <>plus your <G n={s.backerEntryBack} /> back</> : "your entry goes to the opponent"}</span>
          </div>
          <div className="bxb-side pos">
            <span className="label">The Player</span>
            <b className="bxb-fig tnum">{s.playerShare > 0 ? "+" : ""}{fmtGemas(s.playerShare)}</b>
            <span className="meta">{won ? "their share of the surplus" : "never owes anything"}</span>
          </div>
        </div>
        <p className="meta bxb-fee">{won ? <>Fees <G n={s.fees} /> come out of the opponent’s entry first.</> : "No Fees on your side: the winner’s Pot pays them."}</p>
      </div>
    </section>
  );
}

/* ——— C · Three steps, with the Backer bust flush to the bottom edge ——— */
export function VariantC({ onPost }: { onPost: () => void }) {
  return (
    <section className="cut cut-card bk-span bxc" aria-labelledby="bxc-h">
      <Bust name="herBacking" width={210} className="bxc-bust" />
      <div className="bxc-body">
        <h2 id="bxc-h" className="h-section">How Backing works</h2>
        <ol className="bxc-steps">
          <li><span className="bxc-num">1</span><div><b>A Player posts a Request</b><p>They ask for a <G n={EX.entry} /> entry.</p></div></li>
          <li><span className="bxc-num">2</span><div><b>You Offer to back them</b><p>You pay the whole entry and set their share: {pct}%.</p></div></li>
          <li><span className="bxc-num">3</span><div><b>The Match settles</b><p>The Pot pays you first.</p></div></li>
        </ol>
        <div className="bxc-out">
          <div className="won">
            <span className="bxc-tag"><CheckIcon /> Wins</span>
            <span>You <G n={win.backerSurplus} sign /> <small>+ entry back</small></span>
            <span>Player <G n={win.playerShare} sign /></span>
          </div>
          <div className="lost">
            <span className="bxc-tag"><XIcon /> Loses</span>
            <span>You <G n={-EX.entry} sign /></span>
            <span>Player <G n={0} /></span>
          </div>
        </div>
        <div className="bxc-foot">
          <Button variant="money" onClick={onPost}>Post a Request</Button>
          <span className="meta">Fees <G n={win.fees} /> on a win, taken from the opponent’s entry.</span>
        </div>
      </div>
    </section>
  );
}

/* ——— D · Outcome posters: the Backer's result as the giant figure ——— */
export function VariantD({ onPost }: { onPost: () => void }) {
  return (
    <section className="bk-span bxd" aria-labelledby="bxd-h">
      <header className="bxd-head">
        <div>
          <h2 id="bxd-h" className="h-section">How Backing works</h2>
          <p>Back a <G n={EX.entry} /> Match: you pay the entry, the Player keeps {pct}% of what they win.</p>
        </div>
        <Button variant="money" onClick={onPost}>Post a Request</Button>
      </header>
      <div className="bxd-grid">
        <article className="cut cut-card bxd-tile won">
          <span className="bxd-kick"><CheckIcon /> If the Player wins</span>
          <span className="bxd-fig tnum">+{fmtGemas(win.backerSurplus)}</span>
          <span className="bxd-for">for you, plus your <G n={win.backerEntryBack} /> back</span>
          <dl className="bxd-rows">
            <dt>Player gets</dt><dd><GemaAmount value={win.playerShare} size="sm" sign /></dd>
            <dt>Fees</dt><dd><G n={win.fees} /></dd>
          </dl>
        </article>
        <article className="cut cut-card bxd-tile lost">
          <span className="bxd-kick"><XIcon /> If the Player loses</span>
          <span className="bxd-fig tnum">−{fmtGemas(EX.entry)}</span>
          <span className="bxd-for">your entry goes to the opponent</span>
          <dl className="bxd-rows">
            <dt>Player loses</dt><dd>Nothing</dd>
            <dt>Player owes</dt><dd>0 Debt</dd>
          </dl>
        </article>
      </div>
    </section>
  );
}
