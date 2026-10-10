"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, Label } from "@/components/ui";
import { ASSETS, RULES, type Asset } from "../chain";
import { assetBySymbol, midToUsd, usePriceFeed } from "../feed";
import { chips, signedChips, usd, usdMid } from "../fmt";
import { lead, type Ledger } from "../math";
import { TradingScreen, useNow } from "../TradingScreen";
import { seededRng } from "./bot";
import { marked, newSession, playerOrder, stepSession, type Session } from "./session";
import "../trading.css";

const MODES = [
  { id: "full", label: "5 minutes", secs: RULES.durationSecs },
  { id: "quick", label: "60 seconds", secs: 60 },
] as const;
const COUNTDOWN_MS = 4000;

/**
 * Trading Duel practice: the real trading screen on the live oracle price against a local bot.
 * Nothing is staked, there is no wallet and no chain: just the same rules (spread, leverage,
 * liquidation, final mark) so a visitor can try it alone. `?asset=eth` and `?seed=7` (a fixed bot) are honoured.
 */
export function TradingDuelPractice() {
  const sp = useSearchParams();
  const [asset, setAsset] = useState<Asset>(() => assetBySymbol(sp.get("asset")));
  const [mode, setMode] = useState<(typeof MODES)[number]>(MODES[0]);
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const feed = usePriceFeed(asset);
  const seed = sp.get("seed");
  const rng = useRef<() => number>(() => Math.random());
  const latest = useRef({ mid: null as bigint | null, prices: [] as number[] });
  const [round, setRound] = useState(0);

  useEffect(() => {
    latest.current = { mid: feed.tick?.mid ?? null, prices: feed.series.map((p) => p.p) };
  }, [feed]);

  const startsAt = session?.startsAt;
  useEffect(() => {
    if (!startsAt) return;
    const i = setInterval(() => {
      const { mid, prices } = latest.current;
      if (mid === null) return;
      setSession((s) => (s ? stepSession(s, mid, Date.now(), rng.current, prices) : s));
    }, 500);
    return () => clearInterval(i);
  }, [startsAt, round]);

  const start = () => {
    rng.current = seed ? seededRng(Number(seed) || 1) : () => Math.random();
    setError(null);
    setSession(newSession(Date.now() + COUNTDOWN_MS, mode.secs));
    setRound((r) => r + 1);
  };
  const again = () => {
    setSession(null);
    setError(null);
  };

  const order = (o: Parameters<typeof playerOrder>[1]) => {
    const mid = latest.current.mid;
    if (!session || mid === null) return;
    try {
      setSession(playerOrder(session, o, mid, Date.now()));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  if (!session) return <Picker asset={asset} setAsset={setAsset} mode={mode} setMode={setMode} onStart={start} />;

  const mid = feed.tick?.mid ?? null;
  const final = session.final;
  const eq = mid ? marked(session, mid) : null;
  const botLead = eq ? lead(eq) : null;
  const banner = final ? <Result session={session} asset={asset} onAgain={again} /> : (
    <div className="cut cut-card td-card td-banner">
      <p className="meta">
        Practice · nothing staked · you against a bot that follows the trend, on the live {asset.symbol}/USD price. Positions are hidden from the bot&apos;s side of
        the screen just as in a Match.
      </p>
      <Button size="sm" onClick={again}>Stop</Button>
    </div>
  );

  return (
    <TradingScreen
      asset={asset}
      title="Trading Duel practice"
      practice
      feed={feed}
      ledger={session.me as Ledger}
      seat={0}
      opponent={botLead ? { lead: botLead, trades: session.bot.trades } : null}
      startsAt={session.startsAt}
      endsAt={session.endsAt}
      durationSecs={mode.secs}
      ended={!!final}
      busy={null}
      error={error}
      onOpen={(side, margin, leverage) => order({ kind: "open", side, margin, leverage })}
      onClose={() => order({ kind: "close" })}
      onFlip={(side, margin, leverage) => order({ kind: "flip", side, margin, leverage })}
      banner={banner}
    />
  );
}

function Picker({ asset, setAsset, mode, setMode, onStart }: { asset: Asset; setAsset: (a: Asset) => void; mode: (typeof MODES)[number]; setMode: (m: (typeof MODES)[number]) => void; onStart: () => void }) {
  const feed = usePriceFeed(asset);
  const now = useNow(1000);
  const ready = !!feed.tick && feed.status === "live" && now - feed.tick.receivedAt < 5000;
  const price = useMemo(() => (feed.tick ? usd(midToUsd(feed.tick.mid), asset) : "…"), [feed.tick, asset]);
  return (
    <section className="td" aria-label="Trading Duel practice">
      <div className="cut cut-frame td-card" style={{ maxWidth: 560, margin: "0 auto", width: "100%", gap: 16 }}>
        <h1 className="td-title">Trading Duel practice</h1>
        <p className="meta">
          Trade the live price against a bot for {mode.secs >= 120 ? "five minutes" : "a minute"}: long or short, 1x to 20x, one position at a time. Higher equity at
          the end wins. Nothing is staked and no Gemas move.
        </p>
        <div className="stack">
          <Label>Asset</Label>
          <div className="td-pick" role="group" aria-label="Asset">
            {ASSETS.map((a) => (
              <button key={a.id} type="button" className="cut cut-btn" aria-pressed={a.id === asset.id} onClick={() => setAsset(a)}>
                {a.symbol}
              </button>
            ))}
          </div>
          <p className="meta mono" role="status">{asset.symbol}/USD {price} {ready ? "· live" : "· connecting to live prices…"}</p>
        </div>
        <div className="stack">
          <Label>Length</Label>
          <div className="td-pick" role="group" aria-label="Length">
            {MODES.map((m) => (
              <button key={m.id} type="button" className="cut cut-btn" aria-pressed={m.id === mode.id} onClick={() => setMode(m)}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
        <div className="td-banner-row">
          <Button variant="neutral" size="lg" onClick={onStart} disabled={!ready}>Start practice</Button>
          <Button href="/play/trading-duel">Back</Button>
        </div>
        <p className="note">Live market prices, updated every second. Fills carry a {RULES.spreadBps / 100}% spread.</p>
      </div>
    </section>
  );
}

function Result({ session, asset, onAgain }: { session: Session; asset: Asset; onAgain: () => void }) {
  const f = session.final!;
  const title = f.winner === "draw" ? "A draw" : f.winner === 0 ? "You won the practice Match" : "The bot won the practice Match";
  return (
    <div className="cut cut-frame td-card td-banner" role="dialog" aria-label="Practice over">
      <div>
        <Label>{title}</Label>
        <p className="mono td-big">
          {chips(f.equity[0])} <span className="meta">vs bot</span> {chips(f.equity[1])}
        </p>
        <p className="meta">
          You {signedChips(f.equity[0] - 10_000n)} Chips, bot {signedChips(f.equity[1] - 10_000n)} · {asset.symbol} final price {usdMid(f.price, asset)} · {session.me.trades} of your trades. Practice: nothing was staked and no Gemas moved.
        </p>
      </div>
      <div className="td-banner-row">
        <Button onClick={onAgain}>Play again</Button>
        <Button href="/lobby">Lobby</Button>
      </div>
    </div>
  );
}
