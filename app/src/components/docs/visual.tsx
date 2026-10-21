import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ChevronRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/* Visual building blocks for the Docs: icon tiles, framed screenshots, art, step grids and the diagrams. All server components,
   all themed through the docs tokens, motion only under (prefers-reduced-motion: no-preference) in docs-visual.css. */

export type Tone = "emerald" | "sapphire" | "amber" | "violet" | "rose" | "steel";

/** A small cut square with a jewel-tone facet gradient and one icon. Emerald is only for pages where Gemas move. */
export function IconTile({ icon: Icon, tone = "steel", size = "md" }: { icon: LucideIcon; tone?: Tone; size?: "sm" | "md" | "lg" }) {
  return (
    <span className={`dx-tile dx-${size}`} data-tone={tone} aria-hidden>
      <Icon strokeWidth={1.9} />
    </span>
  );
}

/** A real screenshot in a browser frame. `name` is the file in public/docs (shot-<name>.webp, 1280x800). */
export function Shot({ name, alt, caption, url, priority = false, ratio = "1280 / 800" }: { name: string; alt: string; caption?: ReactNode; url: string; priority?: boolean; ratio?: string }) {
  return (
    <figure className="dx-fig">
      <div className="dx-browser cut cut-frame">
        <div className="dx-browser-bar" aria-hidden>
          <i />
          <i />
          <i />
          <span>{url}</span>
        </div>
        <div className="dx-browser-body" style={{ aspectRatio: ratio }}>
          <Image src={`/docs/shot-${name}.webp`} alt={alt} fill sizes="(max-width: 899px) 100vw, (max-width: 1239px) 760px, 760px" priority={priority} />
        </div>
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** Art from public/art in a cut frame. `ratio` is width / height. */
export function Art({ src, alt, ratio, caption, sizes = "(max-width: 899px) 100vw, 760px", position, priority = false, plain = false }: { src: string; alt: string; ratio: string; caption?: ReactNode; sizes?: string; position?: string; priority?: boolean; plain?: boolean }) {
  return (
    <figure className="dx-fig">
      <div className={plain ? "dx-art" : "dx-art cut cut-frame"} style={{ aspectRatio: ratio }}>
        <Image src={src} alt={alt} fill sizes={sizes} priority={priority} style={{ objectFit: "cover", objectPosition: position ?? "center" }} />
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** Dark and light variants of the same art, swapped by the docs theme. */
export function ThemedArt({ dark, light, alt, ratio, caption, sizes = "(max-width: 899px) 100vw, 760px", priority = false }: { dark: string; light: string; alt: string; ratio: string; caption?: ReactNode; sizes?: string; priority?: boolean }) {
  return (
    <figure className="dx-fig">
      <div className="dx-art cut cut-frame" style={{ aspectRatio: ratio }}>
        <Image className="on-dark" src={dark} alt={alt} fill sizes={sizes} priority={priority} style={{ objectFit: "cover" }} />
        <Image className="on-light" src={light} alt={alt} fill sizes={sizes} priority={priority} style={{ objectFit: "cover" }} />
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** A framed diagram: any markup, a caption under it. */
export function Diagram({ label, children, caption, wide = false }: { label: string; children: ReactNode; caption?: ReactNode; wide?: boolean }) {
  return (
    <figure className={`dx-fig dx-diagram${wide ? " is-wide" : ""}`}>
      <div className="dx-diagram-in cut cut-card" role="group" aria-label={label}>
        {children}
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/** Row of key figures. */
export function Stats({ items }: { items: { value: string; label: string; sim?: boolean }[] }) {
  return (
    <dl className="dx-stats">
      {items.map((s) => (
        <div key={s.label}>
          <dd>{s.value}</dd>
          <dt>{s.label}</dt>
        </div>
      ))}
    </dl>
  );
}

/** Two-column numbered step grid. Numbers mean the order is real. `result` is the highlighted last cell: what you end up with. */
export function StepGrid({ items, result }: { items: { title: string; body: ReactNode; icon?: LucideIcon; tone?: Tone }[]; result?: { title: string; body: ReactNode } }) {
  return (
    <ol className="dx-grid">
      {items.map((s, i) => (
        <li key={s.title}>
          <span className="dx-grid-n" aria-hidden>
            {String(i + 1).padStart(2, "0")}
          </span>
          <div className="dx-grid-b">
            <div className="dx-grid-t">
              {s.icon && <IconTile icon={s.icon} tone={s.tone} size="sm" />}
              <b>{s.title}</b>
            </div>
            <p>{s.body}</p>
          </div>
        </li>
      ))}
      {result && (
        <li className="is-result">
          <span className="dx-grid-n" aria-hidden>
            ✦
          </span>
          <div className="dx-grid-b">
            <div className="dx-grid-t">
              <b>{result.title}</b>
            </div>
            <p>{result.body}</p>
          </div>
        </li>
      )}
    </ol>
  );
}

/** A row of short cards with an icon: for lifecycles that are not strictly ordered. */
export function Cards({ items, cols = 3 }: { items: { title: string; body: ReactNode; icon: LucideIcon; tone?: Tone; tag?: string }[]; cols?: 2 | 3 | 4 }) {
  return (
    <ul className={`dx-cards c${cols}`}>
      {items.map((c) => (
        <li key={c.title} className="cut cut-card">
          <IconTile icon={c.icon} tone={c.tone} />
          {c.tag && <span className="dx-tag">{c.tag}</span>}
          <b>{c.title}</b>
          <p>{c.body}</p>
        </li>
      ))}
    </ul>
  );
}

/** Horizontal pipeline of numbered stages with a chevron between them; stacks on a phone. */
export function Pipeline({ items, label }: { items: { title: string; body: ReactNode; icon: LucideIcon; tone?: Tone }[]; label: string }) {
  return (
    <Diagram label={label}>
      <ol className="dx-pipe">
        {items.map((s, i) => (
          <li key={s.title}>
            <IconTile icon={s.icon} tone={s.tone} />
            <b>{s.title}</b>
            <p>{s.body}</p>
            {i < items.length - 1 && <ChevronRight className="dx-pipe-arrow" aria-hidden />}
          </li>
        ))}
      </ol>
    </Diagram>
  );
}

/** Two cards side by side, each with a tone and a list. */
export function Compare({ left, right }: { left: { title: string; icon: LucideIcon; tone?: Tone; items: ReactNode[] }; right: { title: string; icon: LucideIcon; tone?: Tone; items: ReactNode[] } }) {
  return (
    <div className="dx-compare">
      {[left, right].map((c) => (
        <section key={c.title} className="cut cut-card">
          <header>
            <IconTile icon={c.icon} tone={c.tone} size="sm" />
            <b>{c.title}</b>
          </header>
          <ul>
            {c.items.map((it, i) => (
              <li key={i}>{it}</li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/* ——— Diagrams ——— */

const FLOW = [
  { n: 1, title: "Lock", body: "Lock a staking token. What you lock is never played.", img: "step1", ratio: "320 / 437" },
  { n: 2, title: "Advance", body: "Receive 80% of the projected yield, upfront.", img: "step2", ratio: "320 / 260" },
  { n: 3, title: "Gemas", body: "Worth $0.01 each when issued.", img: "step3", ratio: "320 / 260" },
  { n: 4, title: "Match", body: "Enter a head-to-head game. Winner takes the Pot.", img: "step4", ratio: "320 / 260" },
  { n: 5, title: "Redeem", body: "Won Gemas turn into the coin they came from as yield lands.", img: "step5", ratio: "320 / 260" },
];

/** Lock → Advance → Gemas → Match → Redeem, with the loop that pays back the Advance and unlocks your coins. */
export function FlowDiagram() {
  return (
    <Diagram label="The flow from a Lock to Redeem" wide caption="Yield pays back the Advance on its own. When nothing is left to pay back, you can unlock what you locked.">
      <ol className="dx-flow">
        {FLOW.map((s, i) => (
          <li key={s.title} style={{ ["--i" as string]: i }}>
            <span className="dx-flow-art">
              <Image src={`/art/landing/${s.img}-320.webp`} alt="" width={320} height={s.n === 1 ? 437 : 260} sizes="160px" />
            </span>
            <span className="dx-flow-n">{String(s.n).padStart(2, "0")}</span>
            <b>{s.title}</b>
            <p>{s.body}</p>
            {i < FLOW.length - 1 && <ArrowRight className="dx-flow-arrow" aria-hidden />}
          </li>
        ))}
      </ol>
      <div className="dx-loop" aria-hidden>
        <span>The Lock&apos;s yield pays it back</span>
        <i />
        <span>Paid back → Unlock</span>
      </div>
    </Diagram>
  );
}

/** Where a 1,000 Gema Match goes: entries, winner, Fees. Numbers are the real ones (2% + 3% + 1% of the Pot, from the loser). */
export function PayoutBar() {
  return (
    <Diagram label="Where the Pot goes in a 1,000 Gema Match" caption="A 1,000 Gema entry each. Fees come out of the loser's Gemas, so the winner always gets their own entry back whole.">
      <div className="dx-bars">
        <div className="dx-bar-row">
          <span className="dx-bar-label">Pot</span>
          <div className="dx-bar" role="img" aria-label="Pot of 2,000: 1,000 from each Player">
            <i className="seg a" style={{ flex: 1000 }}>
              <b>1,000</b> your entry
            </i>
            <i className="seg b" style={{ flex: 1000 }}>
              <b>1,000</b> opponent&apos;s entry
            </i>
          </div>
        </div>
        <div className="dx-bar-arrow" aria-hidden>
          settles
        </div>
        <div className="dx-bar-row">
          <span className="dx-bar-label">Paid</span>
          <div className="dx-bar" role="img" aria-label="Winner receives 1,880 and Fees of 120">
            <i className="seg win" style={{ flex: 1880 }}>
              <b>1,880</b> winner receives
            </i>
            <i className="seg fee" style={{ flex: 120 }}>
              <b>120</b>
            </i>
          </div>
        </div>
        <div className="dx-bar-row">
          <span className="dx-bar-label">Fees</span>
          <div className="dx-bar" role="img" aria-label="Fees: Platform 40, Studio 60, Leaderboard 20">
            <i className="seg f1" style={{ flex: 40 }}>
              <b>40</b> Platform 2%
            </i>
            <i className="seg f2" style={{ flex: 60 }}>
              <b>60</b> Studio 3%
            </i>
            <i className="seg f3" style={{ flex: 20 }}>
              <b>20</b> Leaderboard 1%
            </i>
          </div>
        </div>
      </div>
    </Diagram>
  );
}

/** A Backing: who gets what when the Player wins (1,000 entry, Player's share 40%) and when they lose. */
export function BackingBars() {
  return (
    <Diagram label="How a Backed Match pays out" caption="1,000 Gema entry, Pot 2,000, the Player's share of the surplus is 40%. Fees are 6% of the Pot, from the loser's Gemas.">
      <div className="dx-bars">
        <p className="dx-bar-title">Player wins</p>
        <div className="dx-bar" role="img" aria-label="Backer entry back 1,000; Backer share 528; Player share 352; Fees 120">
          <i className="seg a" style={{ flex: 1000 }}>
            <b>1,000</b> Backer, entry back
          </i>
          <i className="seg win" style={{ flex: 528 }}>
            <b>+528</b> Backer 60%
          </i>
          <i className="seg player" style={{ flex: 352 }}>
            <b>+352</b> Player 40%
          </i>
          <i className="seg fee" style={{ flex: 120 }}>
            <b>120</b>
          </i>
        </div>
        <p className="dx-bar-title">Player loses</p>
        <div className="dx-bar" role="img" aria-label="Backer loses the 1,000 entry; the Player owes nothing">
          <i className="seg lose" style={{ flex: 1000 }}>
            <b>−1,000</b> Backer loses the entry
          </i>
          <i className="seg none" style={{ flex: 360 }}>
            <b>0</b> Player owes nothing
          </i>
        </div>
        <p className="dx-bar-title">Draw or refund</p>
        <div className="dx-bar" role="img" aria-label="The entry returns to the Backer unchanged">
          <i className="seg a" style={{ flex: 1000 }}>
            <b>1,000</b> entry returns unchanged
          </i>
          <i className="seg none" style={{ flex: 360 }}>
            <b>0</b> Player
          </i>
        </div>
      </div>
    </Diagram>
  );
}

const SHARES = [25, 18, 13, 10, 8, 7, 6, 5, 4, 4];

/** The weekly Season: the week as a track, then the top-10 split of the Pool as bars. */
export function SeasonDiagram() {
  return (
    <Diagram label="A weekly Season and how the Leaderboard Pool is split" caption="Season 1 began on Monday 5 October 2026. Points: one for every 100 Gemas of entry, for a win.">
      <ol className="dx-season">
        <li>
          <b>Mon 00:00 UTC</b>
          <span>Season starts. Everyone is at zero points.</span>
        </li>
        <li>
          <b>All week</b>
          <span>Every Match adds 1% of its Pot to the Pool. Wins earn points.</span>
        </li>
        <li>
          <b>Next Monday</b>
          <span>Ranking recorded on chain, then the top 10 are paid. Unearned shares roll over.</span>
        </li>
      </ol>
      <div className="dx-ranks" role="img" aria-label={`Share of the Pool by rank: ${SHARES.map((s, i) => `${i + 1}: ${s}%`).join(", ")}`}>
        {SHARES.map((s, i) => (
          <div key={i} className="dx-rank">
            <span className="dx-rank-bar" style={{ height: `${s * 3.6}px` }}>
              <b>{s}%</b>
            </span>
            <i>#{i + 1}</i>
          </div>
        ))}
      </div>
    </Diagram>
  );
}

/** Where Locks live and how the ledger hears about them. */
export function ChainPath({ detail = false }: { detail?: boolean }) {
  return (
    <Diagram label="How Ethereum and HyperEVM Locks reach the Solana ledger" caption="Four messages cross, carried by LayerZero V2. Each takes under a minute to a few minutes.">
      <div className="dx-chains">
        <div className="dx-chain-col">
          <div className="dx-chain-box" data-chain="eth">
            <b>Ethereum</b>
            <code>simETH vault{detail ? " · PositionVault" : ""}</code>
          </div>
          <div className="dx-chain-box" data-chain="hype">
            <b>HyperEVM</b>
            <code>simHYPE vault{detail ? " · PositionVaultOApp" : ""}</code>
          </div>
        </div>
        <div className="dx-chain-mid">
          <div className="dx-msg to">
            <span>Lock opened</span>
            <span>Yield reported</span>
            <ArrowRight aria-hidden />
          </div>
          <div className="dx-lz">LayerZero V2</div>
          <div className="dx-msg from">
            <ArrowRight aria-hidden className="back" />
            <span>Payout</span>
            <span>Unlock</span>
          </div>
        </div>
        <div className="dx-chain-col">
          <div className="dx-chain-box solana" data-chain="sol">
            <b>Solana</b>
            <span>The ledger</span>
            <code>Gemas · Advances · Matches · Backings</code>
          </div>
        </div>
      </div>
    </Diagram>
  );
}

/** Rows of "who calls whom": a sequence for developers. */
export function Sequence({ steps, label, caption }: { steps: { from: string; to: string; call: ReactNode; note?: ReactNode }[]; label: string; caption?: ReactNode }) {
  return (
    <Diagram label={label} caption={caption}>
      <ol className="dx-seq">
        {steps.map((s, i) => (
          <li key={i}>
            <span className="dx-seq-n" aria-hidden>
              {i + 1}
            </span>
            <span className="dx-seq-who">
              <i>{s.from}</i>
              <ArrowRight aria-hidden />
              <i>{s.to}</i>
            </span>
            <span className="dx-seq-what">
              <b>{s.call}</b>
              {s.note && <small>{s.note}</small>}
            </span>
          </li>
        ))}
      </ol>
    </Diagram>
  );
}

/** Lock timeline: what is left to pay back falls as yield lands, then Unlock. Illustrative shape, not a measured series. */
export function DebtDiagram() {
  return (
    <Diagram label="How what is left to pay back falls over time" caption="Illustration of a 3 month Length. The line is a straight descent because yield arrives at a steady rate; a real Unlock Estimate moves with the yield actually earned.">
      <svg className="dx-debt" viewBox="0 0 640 220" role="img" aria-label="What is left to pay back starts at the full Advance and falls to zero at the end of the Length, then your Lock unlocks">
        <title>Left to pay back over the Length</title>
        <line x1="56" y1="180" x2="610" y2="180" className="axis" />
        <line x1="56" y1="24" x2="56" y2="180" className="axis" />
        <path d="M56 40 L520 180" className="debt-area-line" />
        <path d="M56 40 L520 180 L56 180 Z" className="debt-area" />
        <circle cx="56" cy="40" r="5" className="dot" />
        <circle cx="520" cy="180" r="5" className="dot" />
        <path d="M520 180 L596 180" className="unlock" />
        <text x="64" y="30" className="t">Advance: 1,750 Gemas to pay back</text>
        <text x="300" y="96" className="t2">yield lands, less left</text>
        <text x="516" y="162" textAnchor="end" className="t">Paid back</text>
        <text x="628" y="203" textAnchor="end" className="t">Unlock: your coins return</text>
        <text x="56" y="203" className="t2">Open</text>
      </svg>
    </Diagram>
  );
}

/** Link tile used in grouped lists. */
export function Row({ href, icon, tone, tag, title, body }: { href: string; icon: LucideIcon; tone: Tone; tag: string; title: string; body: string }) {
  return (
    <Link href={href} className="dx-row">
      <IconTile icon={icon} tone={tone} />
      <span className="dx-row-t">
        <span className="dx-tag">{tag}</span>
        <b>{title}</b>
        <span>{body}</span>
      </span>
      <ArrowRight aria-hidden />
    </Link>
  );
}

/** The twelve gemstone animal pictures a Player can pick. */
export function AvatarStrip() {
  return (
    <Diagram label="The gemstone animal pictures" caption="Twelve gemstone animals. No photos of people, so nobody is asked to upload one.">
      <ul className="dx-avatars">
        {Array.from({ length: 12 }, (_, i) => (
          <li key={i}>
            <Image src={`/art/final/avatars/avatar-${i + 1}.webp`} alt="" width={96} height={96} sizes="96px" />
          </li>
        ))}
      </ul>
    </Diagram>
  );
}

/** A Gema, and the Source that decides what it redeems for. */
export function SourceDiagram() {
  const rows = [
    ["Advance from a SOL Lock", "redeems in test SOL", "#9945ff"],
    ["Advance from an ETH Lock", "redeems in test ETH", "#627eea"],
    ["Advance from a HYPE Lock", "redeems in test HYPE", "#2fc9aa"],
  ];
  return (
    <Diagram label="Every Gema is a claim on the coin it came from" caption="At the table all Gemas are equal. At Redeem, the Lock it came from fixes the coin. Won Gemas keep the coin they came with.">
      <div className="dx-source">
        <div className="dx-source-gem">
          <Image className="on-dark" src="/art/landing/gem-poster.webp" alt="A Gema" width={240} height={300} sizes="160px" />
          <Image className="on-light" src="/art/landing/gem-poster-light.webp" alt="A Gema" width={240} height={300} sizes="160px" />
          <b>1 Gema</b>
          <span>$0.01 when issued</span>
        </div>
        <ul>
          {rows.map(([a, b, c]) => (
            <li key={a} style={{ ["--c" as string]: c }}>
              <span>{a}</span>
              <ArrowRight aria-hidden />
              <b>{b}</b>
            </li>
          ))}
        </ul>
      </div>
    </Diagram>
  );
}

/** The Games as art cards with their facts. */
export function GameCards() {
  const games = [
    { slug: "block-puzzle", name: "Block Puzzle", facts: ["Same pieces for both", "90 second run", "Play when you like"] },
    { slug: "holdem", name: "Buckshot Hold'em", facts: ["Heads-up, real time", "1,500 Chips each", "30 s per action"] },
    { slug: "trading-duel", name: "Trading Duel", facts: ["2.5 minutes, live price", "12 columns, 100 points a hit", "SOL, ETH or HYPE"] },
    { slug: "vanguard", name: "Vanguard", facts: ["Blitz Stratego, hidden ranks", "10 seconds a move", "Capture the Supply Truck"] },
  ];
  return (
    <ul className="dx-games">
      {games.map((g) => (
        <li key={g.slug} className="cut cut-card">
          <span className="dx-games-art">
            <Image src={`/art/final/${g.slug}-tile.webp`} alt="" width={384} height={384} sizes="(max-width: 599px) 90vw, 240px" />
          </span>
          <b>{g.name}</b>
          <ul>
            {g.facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** The system on one page: app and keeper above, Solana programs in the middle, rollup and EVM vaults below. */
export function Architecture() {
  return (
    <Diagram label="Architecture: app, Solana programs, rollup, EVM vaults" wide caption="There are no game servers in the settlement path. The keeper is a fee payer for liveness only: every job is permissionless.">
      <div className="dx-arch">
        <div className="dx-arch-top">
          <div className="dx-arch-box">
            <b>App</b>
            <span>Next.js 16 · Privy wallets · reads chain state directly</span>
          </div>
          <div className="dx-arch-box">
            <b>Keeper</b>
            <span>price feed, relays, expiries</span>
          </div>
        </div>
        <div className="dx-arch-sol">
          <b>Solana · base layer</b>
          <ul>
            <li><code>tesoro_core</code> Accounts, Locks, Gemas, Advances, Matches, Fees, Backing</li>
            <li><code>block_puzzle</code> <code>holdem</code> <code>trading_duel</code> settle by CPI</li>
            <li><code>sim_lst</code> staking token behind SOL Locks</li>
            <li><code>tesoro_bridge</code> LayerZero V2 OApp</li>
          </ul>
        </div>
        <div className="dx-arch-links" aria-hidden>
          <span>delegate / commit</span>
          <span>LayerZero V2 messages</span>
        </div>
        <div className="dx-arch-bottom">
          <div className="dx-arch-box is-per">
            <b>MagicBlock Private Ephemeral Rollup</b>
            <span>Intel TDX TEE · hidden state: Boards, Seed, Deck, hole cards, Books</span>
          </div>
          <div className="dx-arch-box is-evm">
            <b>Ethereum · HyperEVM</b>
            <span>PositionVaultOApp + SimLST on each chain</span>
          </div>
        </div>
      </div>
    </Diagram>
  );
}
