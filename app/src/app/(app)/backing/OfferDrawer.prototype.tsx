"use client";

/**
 * PROTOTYPE ONLY (branch proto/offer-drawer-11-10-2026). Four takes on the MAKE AN OFFER drawer,
 * switched by `?variant=now|A|B|C|D` on /backing (Storybook: Screens/Backing/Offer Drawer).
 * Same terms everywhere: the Backer funds the whole entry, the Player keeps 10 to 90% of the surplus,
 * the Offer lasts 24 hours. Fees are the test registry's (2% + 3%) plus the 1% Leaderboard Fee.
 */
import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, Minus, Plus, X as XMark } from "lucide-react";
import { Button, EntryPicker, GemaMark, Slider } from "@/components/ui";
import { CheckIcon, ClockIcon, XIcon } from "@/components/ui/icons";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar, PlayerName } from "@/components/account/Player";
import { PrototypeSwitcher } from "@/components/prototype/PrototypeSwitcher";
import { art } from "@/lib/art";
import type { ChainRequest } from "@/lib/chain/backing";
import { backedSplit } from "@/lib/chain/ledger";
import { LEADERBOARD_BPS } from "@/lib/chain/season";
import { recordShort, timeLeft } from "@/lib/chain/useBackingBoard";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import type { EntrySize, GameId } from "@/lib/mock";
import "../wallet/money-sheets.css";
import "./offer-drawer.prototype.css";

export const OFFER_VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Exchange" },
  { key: "B", name: "Pot bar" },
  { key: "C", name: "Dossier" },
  { key: "D", name: "Receipt" },
] as const;
export type OfferVariant = (typeof OFFER_VARIANTS)[number]["key"];

export type OfferDrawerProps = {
  target: ChainRequest | "public";
  available: number | null;
  busy: boolean;
  onClose: () => void;
  onSend: (game: GameId, entry: EntrySize, share: number, request: ChainRequest | null) => void;
};

const HERO = { "block-puzzle": art.blockPuzzleHero, holdem: art.holdemHero, "trading-duel": art.tradingDuelHero } as const;
const FEES = { platformBps: 200, studioBps: 300, leaderboardBps: LEADERBOARD_BPS };

function useOffer(p: OfferDrawerProps) {
  const isPublic = p.target === "public";
  const request = isPublic ? null : (p.target as ChainRequest);
  const [game, setGame] = useState<GameId>(request?.game ?? "block-puzzle");
  const [entry, setEntry] = useState<EntrySize>((request?.entry as EntrySize) ?? 1000);
  const [share, setShare] = useState(40);
  const win = backedSplit({ entry, ...FEES, shareBps: share * 100, won: true });
  const short = p.available !== null && p.available < entry;
  const send = () => p.onSend(game, entry, share, request);
  return { isPublic, request, player: request?.player ?? null, game, setGame, entry, setEntry, share, setShare, win, short, send };
}
type Offer = ReturnType<typeof useOffer>;

function ProtoDialog({ className, label, onClose, children }: { className: string; label: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog ref={ref} className={`cut cut-frame po ${className}`} aria-label={label} onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      {children}
      <PrototypeSwitcher variants={OFFER_VARIANTS} inDialog />
    </dialog>
  );
}

function Head({ o, onClose, kicker }: { o: Offer; onClose: () => void; kicker?: ReactNode }) {
  return (
    <div className="po-head">
      <div>
        {kicker}
        <h2 className="h-section">{o.isPublic ? "New public offer" : "Make an offer"}</h2>
      </div>
      <button type="button" className="cut icon-btn" onClick={onClose} aria-label="Close">
        <XMark aria-hidden="true" />
      </button>
    </div>
  );
}

function PublicTerms({ o }: { o: Offer }) {
  return (
    <div className="stack">
      <p className="meta">Post terms; Players apply and you accept one.</p>
      <div className="field">
        <label className="label" htmlFor="po-game">Game</label>
        <select id="po-game" className="cut cut-chip select" value={o.game} onChange={(e) => o.setGame(e.target.value as GameId)}>
          <option value="block-puzzle">{GAME_NAMES["block-puzzle"]}</option>
          <option value="holdem">{GAME_NAMES.holdem}</option>
          <option value="trading-duel">{GAME_NAMES["trading-duel"]}</option>
        </select>
      </div>
      <EntryPicker value={o.entry} onChange={o.setEntry} legend="Entry you fund" name="po-entry" />
    </div>
  );
}

function G({ n, size = 14, sign }: { n: number; size?: number; sign?: "+" | "−" }) {
  return (
    <span className="po-g tnum">
      {sign}
      <GemaMark size={size} />
      {fmtGemas(n)}
    </span>
  );
}

function ShortNote({ o, available }: { o: Offer; available: number | null }) {
  if (!o.short) return null;
  return (
    <p className="status err" role="alert">
      You have {fmtGemas(available ?? 0)} Gemas available. <Link href="/wallet">Get Gemas in your Wallet</Link>
    </p>
  );
}

const ShareSlider = ({ o, label = "Player's share of the surplus" }: { o: Offer; label?: string }) => (
  <Slider label={label} value={o.share} min={10} max={90} step={5} onChange={o.setShare} display={`${o.share}%`} format={(v) => `${v}%`} />
);

/* ——— A. Exchange: the Redeem sheet's "you give / you get" pair, a sticky footer ——— */
function VariantA(p: OfferDrawerProps) {
  const o = useOffer(p);
  const back = o.win.backerEntryBack + o.win.backerSurplus;
  return (
    <ProtoDialog className="po-a" label="Make an Offer" onClose={p.onClose}>
      <div className="po-scroll">
        <div className="po-body">
          <Head o={o} onClose={p.onClose} />
          {o.player ? (
            <div className="po-a-who">
              <span className="cut cut-btn avatar po-a-avatar"><PlayerAvatar account={o.player} size={104} /></span>
              <div>
                <strong><AccountLink account={o.player} newTab /></strong>
                <span className="meta">{GAME_NAMES[o.game]} · {recordShort(o.request!.record)}</span>
              </div>
              <span className="po-a-thumb" aria-hidden="true"><Image src={art.thumb[o.game]} alt="" width={112} height={112} /></span>
            </div>
          ) : (
            <PublicTerms o={o} />
          )}
          <div className="mx-pair">
            <div className="mx-panel cut">
              <div className="mx-head">
                <span className="label">You fund</span>
                <span className="meta">{p.available !== null ? `${fmtGemas(p.available)} available` : "Their whole entry"}</span>
              </div>
              <div className="mx-fig"><GemaMark size={30} glint /><b>{fmtGemas(o.entry)}</b><span>Gemas</span></div>
            </div>
            <span className="mx-arrow cut" aria-hidden="true"><ArrowDown /></span>
            <div className="mx-panel get cut">
              <div className="mx-head">
                <span className="label">If they win, you get</span>
                <span className="meta">Pot <G n={o.entry * 2} size={12} /></span>
              </div>
              <div className="mx-fig"><GemaMark size={30} /><b className="clear">{fmtGemas(back)}</b><span>Gemas</span></div>
              <p className="po-a-sub">
                Your <G n={o.entry} size={12} /> back, plus <G n={o.win.backerSurplus} size={12} /> ({100 - o.share}% of the surplus). They get{" "}
                <G n={o.win.playerShare} size={12} />.
              </p>
              <ShareSlider o={o} />
            </div>
          </div>
          <div className="cut po-a-loss">
            <span className="po-ico lost"><XIcon /></span>
            <p><b>If they lose,</b> you lose <G n={o.entry} size={12} />. They never owe anything.</p>
          </div>
          <ShortNote o={o} available={p.available} />
        </div>
        <footer className="po-foot">
          <p className="meta">Lasts 24 hours. A Backing cannot be revoked once the Match starts.</p>
          <div className="po-actions">
            <Button onClick={p.onClose}>Cancel</Button>
            <Button variant="money" disabled={o.short || p.busy} onClick={o.send}>{o.isPublic ? "Post Offer" : "Make an Offer"}</Button>
          </div>
        </footer>
      </div>
    </ProtoDialog>
  );
}

/* ——— B. Pot bar: the Player's banner, then the win Pot drawn to scale; drag the seam to set the split ——— */
function VariantB(p: OfferDrawerProps) {
  const o = useOffer(p);
  const pot = o.entry * 2;
  const pct = (n: number) => `${(n / pot) * 100}%`;
  const rec = o.request?.record;
  const won = rec?.matches ? Math.round((rec.wins / rec.matches) * 100) : null;
  return (
    <ProtoDialog className="po-b" label="Make an Offer" onClose={p.onClose}>
      <div className="po-scroll">
        <div className="po-b-banner">
          <Image src={HERO[o.game]} alt="" fill sizes="600px" />
          <span className="po-b-game">{GAME_NAMES[o.game]}</span>
          {o.request && <span className="po-b-time"><ClockIcon width={13} height={13} /> {timeLeft(o.request.expiresAt)}</span>}
          <button type="button" className="cut icon-btn po-b-x" onClick={p.onClose} aria-label="Close"><XMark aria-hidden="true" /></button>
        </div>
        <div className="po-body">
          {o.player ? (
            <div className="po-b-who">
              <span className="cut cut-btn avatar po-b-avatar"><PlayerAvatar account={o.player} size={160} /></span>
              <div>
                <span className="label">Make an offer to</span>
                <strong><AccountLink account={o.player} newTab /></strong>
              </div>
              {won !== null && (
                <dl className="po-b-rec">
                  <div><dd>{won}%</dd><dt>Won</dt></div>
                  <div><dd>{rec!.matches}</dd><dt>Matches</dt></div>
                </dl>
              )}
            </div>
          ) : (
            <>
              <h2 className="h-section po-b-title">New public offer</h2>
              <PublicTerms o={o} />
            </>
          )}

          <section className="po-b-pot" aria-label="If they win">
            <div className="po-b-pot-h">
              <span className="po-ico won"><CheckIcon /></span>
              <b>If they win</b>
              <span className="meta">the Pot of <G n={pot} size={12} /> pays</span>
            </div>
            <div className="po-b-bar">
              <i className="back" style={{ width: pct(o.win.backerEntryBack) }} />
              <i className="you" style={{ width: pct(o.win.backerSurplus) }} />
              <i className="them" style={{ width: pct(o.win.playerShare) }} />
              <i className="fees" style={{ width: pct(o.win.fees) }} />
              <input
                type="range"
                aria-label="Player's share of the surplus"
                aria-valuetext={`Player keeps ${o.share}%`}
                min={10}
                max={90}
                step={5}
                value={100 - o.share}
                onChange={(e) => o.setShare(100 - Number(e.target.value))}
                style={{ left: pct(o.win.backerEntryBack), width: pct(o.win.surplus) }}
              />
            </div>
            <ul className="po-b-legend">
              <li className="back"><span>Your entry back</span><G n={o.win.backerEntryBack} /></li>
              <li className="you"><span>You · {100 - o.share}%</span><G n={o.win.backerSurplus} /></li>
              <li className="them"><span>Them · {o.share}%</span><G n={o.win.playerShare} /></li>
              <li className="fees"><span>Fees</span><G n={o.win.fees} /></li>
            </ul>
            <p className="meta po-b-hint">Drag the bar to set how much of the surplus they keep (10 to 90%).</p>
          </section>

          <div className="po-b-cases">
            <div className="cut won">
              <span className="label">They win</span>
              <b className="tnum">+{fmtGemas(o.win.backerSurplus)}</b>
              <span className="meta">for you, after your entry comes back</span>
            </div>
            <div className="cut lost">
              <span className="label">They lose</span>
              <b className="tnum">−{fmtGemas(o.entry)}</b>
              <span className="meta">for you. They never owe anything.</span>
            </div>
          </div>

          <ShortNote o={o} available={p.available} />
          <div className="po-actions">
            <Button onClick={p.onClose}>Cancel</Button>
            <Button variant="money" disabled={o.short || p.busy} onClick={o.send}>
              {o.isPublic ? "Post Offer" : <>Back for <GemaMark size={18} /> {fmtGemas(o.entry)}</>}
            </Button>
          </div>
          <p className="meta">You reserve {fmtGemas(o.entry)} Gemas for 24 hours. A Backing cannot be revoked once the Match starts.</p>
        </div>
      </div>
    </ProtoDialog>
  );
}

/* ——— C. Dossier: wide, the Player's file on the left, the terms as a who-gets-what grid on the right ——— */
function VariantC(p: OfferDrawerProps) {
  const o = useOffer(p);
  const rec = o.request?.record;
  const won = rec?.matches ? Math.round((rec.wins / rec.matches) * 100) : null;
  return (
    <ProtoDialog className="po-c" label="Make an Offer" onClose={p.onClose}>
      <div className="po-scroll">
        <div className="po-c-grid">
          <aside className="po-c-file">
            <div className="po-c-art"><Image src={HERO[o.game]} alt="" fill sizes="400px" /></div>
            {o.player ? (
              <div className="po-c-who">
                <span className="cut cut-btn avatar po-c-avatar"><PlayerAvatar account={o.player} size={200} /></span>
                <strong><AccountLink account={o.player} newTab /></strong>
                <span className="meta">{GAME_NAMES[o.game]} · asks for <G n={o.entry} size={12} /></span>
                {won !== null ? (
                  <>
                    <dl className="po-c-rec">
                      <div><dd>{won}%</dd><dt>Won</dt></div>
                      <div><dd>{rec!.matches}</dd><dt>Matches</dt></div>
                      <div><dd>{rec!.wins}–{rec!.matches - rec!.wins}</dd><dt>W – L</dt></div>
                    </dl>
                    <span className="po-c-bar" aria-hidden="true"><i style={{ width: `${won}%` }} /></span>
                  </>
                ) : (
                  <p className="meta">New Player · no settled Matches yet</p>
                )}
                {o.request && <span className="po-c-time"><ClockIcon width={13} height={13} /> Request {timeLeft(o.request.expiresAt)}</span>}
              </div>
            ) : (
              <div className="po-c-who"><PublicTerms o={o} /></div>
            )}
          </aside>

          <div className="po-c-terms">
            <Head o={o} onClose={p.onClose} />
            <ShareSlider o={o} label="They keep of the surplus" />
            <table className="po-c-table">
              <thead>
                <tr><th /><th scope="col">You</th><th scope="col">{o.player ? <PlayerName account={o.player} /> : "Player"}</th></tr>
              </thead>
              <tbody>
                <tr className="won">
                  <th scope="row"><span className="po-ico won"><CheckIcon /></span> They win</th>
                  <td><b className="tnum">+{fmtGemas(o.win.backerSurplus)}</b><small>entry back, then {100 - o.share}%</small></td>
                  <td><b className="tnum">+{fmtGemas(o.win.playerShare)}</b><small>{o.share}% of the surplus</small></td>
                </tr>
                <tr className="lost">
                  <th scope="row"><span className="po-ico lost"><XIcon /></span> They lose</th>
                  <td><b className="tnum">−{fmtGemas(o.entry)}</b><small>your entry</small></td>
                  <td><b className="tnum">0</b><small>never owe anything</small></td>
                </tr>
              </tbody>
            </table>
            <p className="meta">On a win the Pot is <G n={o.entry * 2} size={12} />; <G n={o.win.fees} size={12} /> of it goes to Fees.</p>
            <ShortNote o={o} available={p.available} />
            <footer className="po-foot">
              <div className="po-c-sum">
                <span className="label">You reserve</span>
                <b><GemaMark size={22} glint /> {fmtGemas(o.entry)}</b>
                <span className="meta">for 24 hours</span>
              </div>
              <div className="po-actions">
                <Button onClick={p.onClose}>Cancel</Button>
                <Button variant="money" disabled={o.short || p.busy} onClick={o.send}>{o.isPublic ? "Post Offer" : "Make an Offer"}</Button>
              </div>
            </footer>
          </div>
        </div>
      </div>
    </ProtoDialog>
  );
}

/* ——— D. Receipt: narrow ticket; one sentence, a stepper, then the itemised outcomes and one big action ——— */
function VariantD(p: OfferDrawerProps) {
  const o = useOffer(p);
  const step = (d: number) => o.setShare(Math.min(90, Math.max(10, o.share + d)));
  return (
    <ProtoDialog className="po-d" label="Make an Offer" onClose={p.onClose}>
      <div className="po-scroll">
        <div className="po-body">
          <div className="po-d-top">
            <span className="po-d-tag">{o.isPublic ? "Public offer" : "Offer"}</span>
            <button type="button" className="cut icon-btn" onClick={p.onClose} aria-label="Close"><XMark aria-hidden="true" /></button>
          </div>
          {o.player ? (
            <div className="po-d-lede">
              <span className="cut cut-btn avatar po-d-avatar"><PlayerAvatar account={o.player} size={72} /></span>
              <p>
                Back <AccountLink account={o.player} newTab /> in {GAME_NAMES[o.game]} with <G n={o.entry} size={22} />.
              </p>
            </div>
          ) : (
            <>
              <p className="po-d-lede-public">Fund one Player’s entry. Players apply; you pick one.</p>
              <PublicTerms o={o} />
            </>
          )}

          <div className="po-d-step" role="group" aria-label="Player's share of the surplus">
            <button type="button" className="cut" onClick={() => step(-5)} disabled={o.share <= 10} aria-label="Less for the Player"><Minus /></button>
            <div>
              <b className="tnum">{o.share}%</b>
              <span>they keep of the surplus</span>
            </div>
            <button type="button" className="cut" onClick={() => step(5)} disabled={o.share >= 90} aria-label="More for the Player"><Plus /></button>
          </div>

          <hr className="po-d-perf" />

          <dl className="po-d-rows">
            <div className="po-d-sec"><dt><span className="po-ico won"><CheckIcon /></span> If they win</dt></div>
            <div><dt>Your entry back</dt><dd><G n={o.win.backerEntryBack} /></dd></div>
            <div><dt>Your share · {100 - o.share}%</dt><dd className="em"><G n={o.win.backerSurplus} sign="+" /></dd></div>
            <div><dt>Their share · {o.share}%</dt><dd><G n={o.win.playerShare} /></dd></div>
            <div><dt>Fees</dt><dd><G n={o.win.fees} /></dd></div>
            <div className="po-d-sec"><dt><span className="po-ico lost"><XIcon /></span> If they lose</dt></div>
            <div><dt>You lose</dt><dd className="bad"><G n={o.entry} sign="−" /></dd></div>
            <div><dt>They owe</dt><dd>Nothing</dd></div>
            <div className="po-d-sec" />
            <div><dt>Offer lasts</dt><dd>24 hours</dd></div>
            <div><dt>Revocable</dt><dd>Until the Match starts</dd></div>
          </dl>

          <ShortNote o={o} available={p.available} />
          <Button variant="money" block disabled={o.short || p.busy} onClick={o.send}>
            {o.isPublic ? "Post Offer" : "Offer"} <GemaMark size={20} /> {fmtGemas(o.entry)}
          </Button>
          <button type="button" className="po-d-cancel" onClick={p.onClose}>Cancel</button>
        </div>
      </div>
    </ProtoDialog>
  );
}

export function OfferDrawerPrototype({ variant, ...p }: OfferDrawerProps & { variant: Exclude<OfferVariant, "now"> }) {
  if (variant === "A") return <VariantA {...p} />;
  if (variant === "B") return <VariantB {...p} />;
  if (variant === "C") return <VariantC {...p} />;
  return <VariantD {...p} />;
}
