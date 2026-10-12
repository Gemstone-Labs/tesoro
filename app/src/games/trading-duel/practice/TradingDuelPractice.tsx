"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button, Label } from "@/components/ui";
import { art } from "@/lib/art";
import { ASSETS, type Asset } from "../chain";
import { assetBySymbol, midToUsd, usePriceFeed } from "../feed";
import { usd } from "../fmt";
import { MATCH_SECS, revealed, type GridAsset } from "../grid";
import { GridScreen } from "../GridScreen";
import { seededRng } from "./bot";
import { elapsed, newGridSession, setPick, stepGridSession, type GridSession } from "./gridSession";
import "../trading.css";
import { Arena, MuteToggle } from "../../fx";

/** The bot's face in practice: a fixed gemstone animal, labelled "Bot". */
const YOU = { name: "You", avatar: art.avatars[0] };
const BOT = { name: "Bot", avatar: art.avatars[4] };

/**
 * Trading Duel practice: the real grid screen on the live price against a local bot. Nothing is
 * staked, there is no wallet and no chain. `?asset=eth` and `?seed=7` (a fixed bot) are honoured.
 */
export function TradingDuelPractice() {
  const sp = useSearchParams();
  const [asset, setAsset] = useState<Asset>(() => assetBySymbol(sp.get("asset")));
  const [session, setSession] = useState<GridSession | null>(null);
  const [clock, setClock] = useState(0);
  const feed = usePriceFeed(asset);
  const seed = sp.get("seed");
  const rng = useRef<() => number>(() => Math.random());
  const latest = useRef({ mid: null as bigint | null, prices: [] as number[] });

  useEffect(() => {
    latest.current = { mid: feed.tick?.mid ?? null, prices: feed.series.map((p) => p.p) };
  }, [feed]);

  const startsAt = session?.startsAt;
  useEffect(() => {
    if (!startsAt) return;
    const i = setInterval(() => {
      const { mid, prices } = latest.current;
      const now = Date.now();
      setClock(now);
      if (mid !== null) setSession((s) => (s ? stepGridSession(s, mid, now, rng.current, prices) : s));
    }, 500);
    return () => clearInterval(i);
  }, [startsAt]);

  const start = () => {
    const mid = latest.current.mid;
    if (mid === null) return;
    rng.current = seed ? seededRng(Number(seed) || 1) : () => Math.random();
    setSession(newGridSession(Date.now(), mid, asset.symbol as GridAsset, rng.current));
  };

  const series = useMemo(() => feed.series, [feed.series]);

  if (!session) return <Picker asset={asset} setAsset={setAsset} onStart={start} />;

  const t = elapsed(session, clock || session.startsAt);
  const final = session.final;
  return (
    <GridScreen
      asset={asset.symbol as GridAsset}
      anchor={session.anchor}
      step={session.step}
      startsAt={session.startsAt}
      track={session.track}
      series={series}
      price={feed.tick?.mid ?? null}
      stale={feed.status === "stale"}
      mine={session.picks[0]}
      theirs={revealed(session.picks[1], Math.min(t, MATCH_SECS))}
      me={YOU}
      opponent={BOT}
      final={final ? { you: final.scores[0], them: final.scores[1] } : null}
      practice
      title="Trading Duel practice"
      onPick={(c, r) => {
        try {
          setSession((s) => (s ? setPick(s, c, r, Date.now()) : s));
        } catch {
          // the column locked a moment ago: the screen already shows it
        }
      }}
      onPlayAgain={() => setSession(null)}
      exitHref="/lobby"
    />
  );
}

function Picker({ asset, setAsset, onStart }: { asset: Asset; setAsset: (a: Asset) => void; onStart: () => void }) {
  const feed = usePriceFeed(asset);
  const ready = !!feed.tick && feed.status === "live";
  const price = feed.tick ? usd(midToUsd(feed.tick.mid), asset) : "…";
  return (
    <Arena game="trading-duel">
      <section className="td" aria-label="Trading Duel practice">
        <div className="cut cut-frame td-card" style={{ maxWidth: 560, margin: "0 auto", width: "100%", gap: 16 }}>
          <div className="td-head-l">
            <h1 className="td-title">Trading Duel practice</h1>
            <MuteToggle />
          </div>
          <p className="meta">
            Pick where the price will be. Each box is a stretch of price and a ten second column: when the live line passes through your box, you score 100
            points. You have 12 columns over two and a half minutes; more points than the bot wins. Nothing is staked and no Gemas move.
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
            <p className="meta mono" role="status">
              {asset.symbol}/USD {price} {ready ? "· live" : "· connecting to live prices…"}
            </p>
          </div>
          <div className="td-banner-row">
            <Button variant="neutral" size="lg" onClick={onStart} disabled={!ready}>Start practice</Button>
            <Button href="/play/trading-duel">Back</Button>
          </div>
        </div>
      </section>
    </Arena>
  );
}

