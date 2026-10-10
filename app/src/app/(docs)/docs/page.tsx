import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Gem,
  HandCoins,
  Layers,
  Lock,
  Network,
  Percent,
  Route,
  ScrollText,
  ShieldCheck,
  Swords,
  Timer,
  Trophy,
  TriangleAlert,
  UserRound,
  Workflow,
  Terminal,
  Cpu,
  Repeat,
  Sprout,
  Hourglass,
  Waypoints,
  KeyRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Sim } from "@/components/docs/prose";
import { ALL_PAGES } from "@/components/docs/nav";
import { CHANGES } from "@/components/docs/changelog";
import { StartCards } from "@/components/docs/StartCards";
import { Cards, Row, Stats } from "@/components/docs/visual";
import type { Tone } from "@/components/docs/visual";

export const metadata: Metadata = { title: "Overview", alternates: { canonical: "/docs" } };

type Item = { href: string; icon: LucideIcon; tone: Tone; tag: string };
type Group = { n: string; name: string; purpose: string; start: string; items: Item[] };

const GROUPS: Group[] = [
  {
    n: "01",
    name: "Start",
    purpose: "What Tesoro is, the whole loop in five steps, and how you sign in.",
    start: "/docs/how-it-works",
    items: [
      { href: "/docs/how-it-works", icon: Workflow, tone: "sapphire", tag: "the loop" },
      { href: "/docs/accounts", icon: UserRound, tone: "rose", tag: "sign in" },
    ],
  },
  {
    n: "02",
    name: "Your Position",
    purpose: "Lock a staking token, take an Advance, hold Gemas, and know what it costs.",
    start: "/docs/positions",
    items: [
      { href: "/docs/positions", icon: Lock, tone: "emerald", tag: "position · advance · debt" },
      { href: "/docs/gemas", icon: Gem, tone: "emerald", tag: "source · redeem" },
      { href: "/docs/fees", icon: Percent, tone: "emerald", tag: "2% + 3% + 1%" },
    ],
  },
  {
    n: "03",
    name: "Play",
    purpose: "Three head-to-head Games, the weekly Leaderboard, and why results can be trusted.",
    start: "/docs/matches",
    items: [
      { href: "/docs/matches", icon: Swords, tone: "sapphire", tag: "queue · challenge · practice" },
      { href: "/docs/leaderboard", icon: Trophy, tone: "emerald", tag: "seasons · top 10" },
      { href: "/docs/fairness", icon: ShieldCheck, tone: "violet", tag: "hidden · verifiable" },
    ],
  },
  {
    n: "04",
    name: "Back a Player",
    purpose: "Fund another Player's entry and share what they win.",
    start: "/docs/backing",
    items: [{ href: "/docs/backing", icon: HandCoins, tone: "emerald", tag: "request · offer · split" }],
  },
  {
    n: "05",
    name: "Chains and limits",
    purpose: "Where Positions live, and an honest list of what can go wrong.",
    start: "/docs/chains",
    items: [
      { href: "/docs/chains", icon: Network, tone: "steel", tag: "solana · ethereum · hyperevm" },
      { href: "/docs/risks", icon: TriangleAlert, tone: "amber", tag: "test mode · trust" },
    ],
  },
  {
    n: "06",
    name: "Developers",
    purpose: "The pieces, the program IDs, how a Game settles, and how to run it.",
    start: "/docs/developers",
    items: [
      { href: "/docs/developers", icon: Layers, tone: "violet", tag: "architecture" },
      { href: "/docs/developers/programs", icon: ScrollText, tone: "sapphire", tag: "program ids" },
      { href: "/docs/developers/settlement", icon: Route, tone: "amber", tag: "settle_match" },
      { href: "/docs/developers/rollups", icon: Cpu, tone: "violet", tag: "magicblock per" },
      { href: "/docs/developers/cross-chain", icon: Waypoints, tone: "steel", tag: "layerzero v2" },
      { href: "/docs/developers/simulated-yield", icon: Timer, tone: "rose", tag: "1 month = 10 min" },
      { href: "/docs/developers/security", icon: KeyRound, tone: "amber", tag: "review · incident" },
      { href: "/docs/developers/run", icon: Terminal, tone: "sapphire", tag: "clone · build · test" },
    ],
  },
];

const page = (href: string) => ALL_PAGES.find((p) => p.href === href)!;

const BUILT_ON: [string, string][] = [
  ["Solana", "#9945ff"],
  ["MagicBlock Private Ephemeral Rollups", "#5b9cf0"],
  ["LayerZero V2", "#8b6cf0"],
  ["Ethereum (Hoodi)", "#627eea"],
  ["HyperEVM", "#2fc9aa"],
  ["Privy", "#d98c22"],
];

export default function Page() {
  return (
    <div className="docs-index">
      <section className="dx-hero" aria-labelledby="docs-title">
        <div>
          <p className="dx-eyebrow">Documentation</p>
          <h1 id="docs-title">Tesoro Docs</h1>
          <p className="dx-hero-lede">
            Stake a token, then <b>play now with the yield it has not earned yet</b>. Your Principal stays locked and is never played. These pages cover
            it in plain words for players and in full detail for developers.
          </p>
          <Stats
            items={[
              { value: "3", label: "Games" },
              { value: "3", label: "Chains" },
              { value: "6", label: "Solana programs" },
              { value: "$0.01", label: "1 Gema at issuance" },
              { value: "10 min", label: "1 month, simulated" },
            ]}
          />
          <p className="dx-hero-note">
            Test mode: <Sim /> yield on test networks. Nothing here has value. <Link href="/docs/risks">Risks and limits</Link>
          </p>
        </div>
        <StartCards />
      </section>

      <section className="dx-band" aria-labelledby="what-is">
        <h2 id="what-is">What is Tesoro?</h2>
        <p className="dx-band-big">Staking yield sits idle, and play costs your principal. Tesoro lets you play with the yield before it arrives.</p>
        <Cards
          items={[
            { tag: "The problem", title: "Yield waits, play costs", icon: Hourglass, tone: "amber", body: "Staked tokens earn slowly, and anything you want to play with has to come out of the amount you staked." },
            { tag: "The fix", title: "Play now, Principal never played", icon: Sprout, tone: "emerald", body: "An Advance pays your Position's projected yield upfront as Gemas. Your Principal stays locked, and the Position's own yield repays the Advance." },
            { tag: "Why it compounds", title: "Winners redeem as yield lands", icon: Repeat, tone: "emerald", body: "Gemas you win turn into the loser's Source asset as that yield arrives. Backing and the weekly Leaderboard Pool give more Gemas a reason to move." },
          ]}
        />
        <div className="dx-works" aria-label="Built on">
          <span>Built on</span>
          {BUILT_ON.map(([n, c]) => (
            <span key={n} className="dx-chip" style={{ ["--c" as string]: c }}>
              {n}
            </span>
          ))}
        </div>
      </section>

      <section aria-labelledby="read">
        <h2 id="read" className="dx-log-h">
          Read it your way
        </h2>
        <div className="dx-groups">
          {GROUPS.map((g) => (
            <div key={g.n} className="dx-group" id={`g-${g.n}`}>
              <div className="dx-group-l">
                <h2>
                  <span>{g.n}</span>
                  {g.name}
                </h2>
                <p>{g.purpose}</p>
                <Link href={g.start} className="dx-start-more">
                  Start with <code>{page(g.start).title}</code> <ArrowRight aria-hidden />
                </Link>
              </div>
              <div className="dx-group-r">
                {g.items.map((it) => (
                  <Row key={it.href} href={it.href} icon={it.icon} tone={it.tone} tag={it.tag} title={page(it.href).title} body={page(it.href).summary} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section aria-labelledby="changed">
        <h2 id="changed" className="dx-log-h">
          What changed recently
        </h2>
        <ul className="dx-log">
          {CHANGES.map((c) => (
            <li key={c.title}>
              {c.href ? (
                <Link href={c.href}>
                  <time dateTime={c.iso}>{c.date}</time>
                  <span>
                    <b>{c.title}</b>
                    {c.body}
                  </span>
                  <ArrowRight aria-hidden />
                </Link>
              ) : (
                <>
                  <time dateTime={c.iso}>{c.date}</time>
                  <span>
                    <b>{c.title}</b>
                    {c.body}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
        <p className="dx-hero-note">
          Stuck on something in the app? The <Link href="/help">Help page</Link> answers common questions in short form.
        </p>
      </section>
    </div>
  );
}
