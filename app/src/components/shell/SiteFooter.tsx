import Link from "next/link";
import { TesoroLogo } from "@/components/brand";
import { ChainGlyph } from "@/components/ui";
import { LAUNCH_STAGE } from "@/lib/landing/config";

const CHAINS = [
  { asset: 0, name: "Solana" },
  { asset: 1, name: "Ethereum" },
  { asset: 2, name: "HyperEVM" },
] as const;

const COLUMNS: { title: string; links: [label: string, href: string | null][] }[] = [
  { title: "Play", links: [["Lobby", "/lobby"], ["Games", "/play"], ["Leaderboard", "/leaderboard"], ["Your Matches", "/matches"]] },
  { title: "Money", links: [["Wallet", "/wallet"], ["Backing", "/backing"]] },
  { title: "Learn", links: [["Docs", "/docs"], ["Help", "/help"], ["Legal", null]] },
];

/** Brand block and link columns, then a strip with the fair-play note and the simulated-yield label. */
export function SiteFooter() {
  return (
    <footer className="site-foot">
      <div className="site-foot-in">
        <div className="site-foot-brand">
          <Link href="/lobby" aria-label="Tesoro, home">
            <TesoroLogo height={30} />
          </Link>
          <p>Skill games on Solana. Your staking Principal is never played.</p>
          <ul className="site-foot-chains" aria-label="Positions on">
            {CHAINS.map((c) => (
              <li key={c.asset} className="cut cut-chip">
                <ChainGlyph asset={c.asset} size={16} />
                {c.name}
              </li>
            ))}
          </ul>
        </div>
        <nav className="site-foot-cols" aria-label="Footer">
          {COLUMNS.map((col) => (
            <div key={col.title}>
              <p className="site-foot-h">{col.title}</p>
              {col.links.map(([label, href]) =>
                href ? (
                  <Link key={label} href={href}>
                    {label}
                  </Link>
                ) : (
                  <span key={label} aria-disabled="true" title="Coming soon">
                    {label}
                  </span>
                ),
              )}
            </div>
          ))}
        </nav>
      </div>
      <div className="site-foot-strip">
        <span className="site-foot-fair">Fair play · every result on record</span>
        {LAUNCH_STAGE === "testnet" && <span className="site-foot-test">Test mode · simulated yield · 1 month = 10 min</span>}
        <span>© 2026 Gemstone Labs</span>
      </div>
    </footer>
  );
}
