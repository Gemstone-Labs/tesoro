"use client";

/* PROTOTYPE ONLY: four takes on the app footer (?variant=now|A|B|C|D). Branch proto/site-footer-11-10-2026. */
import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { BookOpen, CircleHelp, Gamepad2, HandCoins, House, Trophy, Wallet } from "lucide-react";
import { TesoroLogo, TesoroMark } from "@/components/brand";
import { ChainGlyph, GemaMark } from "@/components/ui";
import { art } from "@/lib/art";
import { usePool } from "@/lib/chain/usePool";
import { seasonAt, seasonEnd } from "@/lib/chain/season";
import "./site-footer.prototype.css";

const CHAINS = [
  { asset: 0, name: "Solana" },
  { asset: 1, name: "Ethereum" },
  { asset: 2, name: "HyperEVM" },
] as const;

function Legal() {
  return (
    <span aria-disabled="true" title="Coming soon">
      Legal
    </span>
  );
}

function useNow(ms = 1000) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function left(secs: number) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m ${secs % 60}s`;
}

const compact = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K` : n.toLocaleString("en-US"));

/* ——— A · Directory: brand block + link columns + a legal strip ——— */
export function FooterA() {
  return (
    <footer className="sfa">
      <div className="sfa-in">
        <div className="sfa-brand">
          <Link href="/lobby" aria-label="Tesoro, home">
            <TesoroLogo height={30} />
          </Link>
          <p>Skill games on Solana. Your staking Principal is never played.</p>
          <div className="sfa-chains">
            {CHAINS.map((c) => (
              <span key={c.asset} className="cut cut-chip sfa-chain">
                <ChainGlyph asset={c.asset} size={16} />
                {c.name}
              </span>
            ))}
          </div>
        </div>
        <nav className="sfa-cols" aria-label="Footer">
          <div>
            <h3>Play</h3>
            <Link href="/lobby">Lobby</Link>
            <Link href="/play">Games</Link>
            <Link href="/leaderboard">Leaderboard</Link>
            <Link href="/matches">Your Matches</Link>
          </div>
          <div>
            <h3>Money</h3>
            <Link href="/wallet">Wallet</Link>
            <Link href="/backing">Backing</Link>
          </div>
          <div>
            <h3>Learn</h3>
            <Link href="/docs">Docs</Link>
            <Link href="/help">Help</Link>
            <Legal />
          </div>
        </nav>
      </div>
      <div className="sfa-strip">
        <span>
          <i className="sfa-ok" aria-hidden="true" />
          Fair play · every result on record
        </span>
        <span className="sfa-test">
          <i aria-hidden="true" />
          Test mode · simulated yield · 1 month = 10 min
        </span>
        <span>© 2026 Gemstone Labs</span>
      </div>
    </footer>
  );
}

/* ——— B · Sign-off: centred mark over the octagon texture, links, three seals ——— */
export function FooterB() {
  return (
    <footer className="sfb">
      <div className="sfb-glow" aria-hidden="true" />
      <Link href="/lobby" className="sfb-mark" aria-label="Tesoro, home">
        <TesoroMark size={52} />
      </Link>
      <nav className="sfb-links" aria-label="Footer">
        <Link href="/lobby">Lobby</Link>
        <Link href="/play">Play</Link>
        <Link href="/backing">Backing</Link>
        <Link href="/leaderboard">Leaderboard</Link>
        <Link href="/wallet">Wallet</Link>
        <Link href="/docs">Docs</Link>
        <Link href="/help">Help</Link>
        <Legal />
      </nav>
      <ul className="sfb-seals">
        <li>
          <b>Fair play</b>
          <span>Every result on record</span>
        </li>
        <li>
          <b>Settled on Solana</b>
          <span>Powered by MagicBlock</span>
        </li>
        <li className="test">
          <b>Test mode</b>
          <span>Simulated yield · 1 month = 10 min</span>
        </li>
      </ul>
    </footer>
  );
}

/* ——— C · Last call: a poster banner with one more Match, then the quiet line ——— */
export function FooterC() {
  return (
    <footer className="sfc">
      <div className="cut cut-frame sfc-banner">
        <Image className="sfc-art" src={art.hero.holdem} alt="" fill sizes="(min-width: 1024px) 900px, 100vw" />
        <div className="sfc-copy">
          <span className="sfc-kicker">Before you go</span>
          <h2>One more Match?</h2>
          <p>Your Gemas are already earning. Put them on the table.</p>
          <div className="sfc-ctas">
            <Link href="/play" className="cut cut-btn btn money">
              <GemaMark size={16} /> Play now
            </Link>
            <Link href="/backing" className="cut cut-btn btn neutral">
              Back a Player
            </Link>
          </div>
        </div>
      </div>
      <div className="sfc-line">
        <TesoroMark size={22} />
        <span>Fair play · every result on record</span>
        <span className="sfc-test">Test mode · 1 month = 10 min</span>
        <nav aria-label="Footer">
          <Link href="/wallet">Wallet</Link>
          <Link href="/backing">Backing</Link>
          <Link href="/help">Help</Link>
          <Link href="/docs">Docs</Link>
          <Legal />
        </nav>
      </div>
    </footer>
  );
}

/* ——— D · Instrument strip: live readouts (network, sim clock, Pool, Season), then links ——— */
export function FooterD() {
  const now = useNow();
  const pool = usePool();
  const ts = now === null ? null : Math.floor(now / 1000);
  const season = ts === null ? null : seasonAt(ts);
  const ends = ts === null || season === null ? null : seasonEnd(season) - ts;
  // 1 month = 10 min: the share of the current sim month gone by.
  const month = now === null ? 0 : (now % 600_000) / 600_000;
  return (
    <footer className="sfd">
      <div className="sfd-readouts">
        <div className="sfd-cell">
          <span className="sfd-k">Network</span>
          <span className="sfd-v">
            <i className="sfd-live" aria-hidden="true" />
            Solana · live
          </span>
        </div>
        <div className="sfd-cell">
          <span className="sfd-k">Yield clock</span>
          <span className="sfd-v">
            <svg className="sfd-ring" viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="10" cy="10" r="8" />
              <circle cx="10" cy="10" r="8" style={{ strokeDashoffset: 50.27 * (1 - month) }} />
            </svg>
            1 month = 10 min
          </span>
        </div>
        <Link href="/leaderboard" className="sfd-cell sfd-pool">
          <span className="sfd-k">Leaderboard Pool</span>
          <span className="sfd-v">
            <GemaMark size={14} />
            {pool === null ? "—" : compact(pool)}
          </span>
        </Link>
        <Link href="/leaderboard" className="sfd-cell">
          <span className="sfd-k">Season {season ?? ""}</span>
          <span className="sfd-v">ends in {ends === null ? "—" : left(ends)}</span>
        </Link>
        <div className="sfd-cell sfd-chains">
          <span className="sfd-k">Positions on</span>
          <span className="sfd-v">
            {CHAINS.map((c) => (
              <span key={c.asset} title={c.name}>
                <ChainGlyph asset={c.asset} size={16} />
              </span>
            ))}
          </span>
        </div>
      </div>
      <div className="sfd-base">
        <span>Fair play · every result on record · test mode, simulated yield</span>
        <nav aria-label="Footer">
          <Link href="/lobby"><House aria-hidden="true" />Lobby</Link>
          <Link href="/play"><Gamepad2 aria-hidden="true" />Play</Link>
          <Link href="/backing"><HandCoins aria-hidden="true" />Backing</Link>
          <Link href="/leaderboard"><Trophy aria-hidden="true" />Leaderboard</Link>
          <Link href="/wallet"><Wallet aria-hidden="true" />Wallet</Link>
          <Link href="/docs"><BookOpen aria-hidden="true" />Docs</Link>
          <Link href="/help"><CircleHelp aria-hidden="true" />Help</Link>
          <Legal />
        </nav>
      </div>
    </footer>
  );
}
