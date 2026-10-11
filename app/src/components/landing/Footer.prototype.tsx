"use client";

/**
 * PROTOTYPE ONLY (branch proto/landing-footer-11-10-2026). The current landing footer with add-ons layered on top,
 * picked with `?variant=` on /welcome:
 *   now  the footer as shipped: logo, Docs / X / GitHub, the test-mode line
 *   A    Pitch line: one sentence under the logo and © Gemstone Labs
 *   B    Link columns: Play / Learn / Follow, so the footer reaches the app pages too
 *   C    Chain chips: Solana / Ethereum / HyperEVM under the logo
 *   D    Mono strip: a bottom strip with the fair-play note, the amber test-mode label and ©
 *   E    Cave floor: the footer carries the landing texture and an emerald seam, so it reads as part of the cave
 *   F    A + B + C + D + E together
 */
import { TesoroLogo } from "@/components/brand";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { ChainGlyph } from "@/components/ui";
import { LAUNCH_STAGE, OUTBOUND, appHref } from "@/lib/landing/config";
import "./footer.prototype.css";

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Pitch line" },
  { key: "B", name: "Link columns" },
  { key: "C", name: "Chain chips" },
  { key: "D", name: "Mono strip" },
  { key: "E", name: "Cave floor" },
  { key: "F", name: "A + B + C + D + E" },
] as const;
type Key = (typeof VARIANTS)[number]["key"];
type Flags = { pitch?: boolean; cols?: boolean; chains?: boolean; strip?: boolean; floor?: boolean };
const FLAGS: Record<Key, Flags> = {
  now: {},
  A: { pitch: true },
  B: { cols: true },
  C: { chains: true },
  D: { strip: true },
  E: { floor: true },
  F: { pitch: true, cols: true, chains: true, strip: true, floor: true },
};

const LINKS = [
  ["Docs", OUTBOUND.docs],
  ["X", OUTBOUND.x],
  ["GitHub", OUTBOUND.github],
] as const;

const COLUMNS: { title: string; links: (readonly [string, string | undefined])[] }[] = [
  { title: "Play", links: [["Lobby", appHref("/lobby")], ["Games", appHref("/play")], ["Leaderboard", appHref("/leaderboard")]] },
  { title: "Learn", links: [["Docs", OUTBOUND.docs], ["Help", appHref("/help")], ["Wallet", appHref("/wallet")]] },
  { title: "Follow", links: [["X", OUTBOUND.x], ["GitHub", OUTBOUND.github]] },
];

const CHAINS = [
  { asset: 0, name: "Solana" },
  { asset: 1, name: "Ethereum" },
  { asset: 2, name: "HyperEVM" },
] as const;

function A({ label, href }: { label: string; href: string | undefined }) {
  return href ? (
    <a href={href} rel="noopener">
      {label}
    </a>
  ) : (
    <span className="lp-dim" aria-disabled="true" title="Coming soon">
      {label}
    </span>
  );
}

export function FooterPrototype() {
  const key = usePrototypeVariant(VARIANTS.map((v) => v.key));
  const f = FLAGS[key];
  const testnet = LAUNCH_STAGE === "testnet";
  const rich = f.pitch || f.cols || f.chains;

  return (
    <footer className={`lp-footer${f.floor ? " fp-floor" : ""}`}>
      {rich ? (
        <div className="lp-wrap fp-in">
          <div className="fp-brand">
            <span className="lp-logo">
              <TesoroLogo height={26} tone="dark" className="on-dark" />
              <TesoroLogo height={26} tone="light" className="on-light" />
            </span>
            {f.pitch && <p className="fp-pitch">Play now with yield you haven&apos;t earned yet. Your Principal is never played.</p>}
            {f.chains && (
              <ul className="fp-chains mono" aria-label="Positions on">
                {CHAINS.map((c) => (
                  <li key={c.asset} className="cut cut-chip">
                    <ChainGlyph asset={c.asset} size={16} />
                    {c.name}
                  </li>
                ))}
              </ul>
            )}
            {!f.cols && (
              <nav className="lp-footer-links mono" aria-label="Elsewhere">
                {LINKS.map(([label, href]) => (
                  <A key={label} label={label} href={href} />
                ))}
              </nav>
            )}
          </div>
          {f.cols && (
            <nav className="fp-cols" aria-label="Footer">
              {COLUMNS.map((col) => (
                <div key={col.title}>
                  <p className="fp-h">{col.title}</p>
                  {col.links.map(([label, href]) => (
                    <A key={label} label={label} href={href} />
                  ))}
                </div>
              ))}
            </nav>
          )}
          {!f.strip && testnet && <p className="mono lp-footer-stage fp-stage">test mode · no real value</p>}
          {!f.strip && f.pitch && <p className="mono fp-copy">© 2026 Gemstone Labs</p>}
        </div>
      ) : (
        <div className="lp-wrap lp-footer-in">
          <span className="lp-logo">
            <TesoroLogo height={26} tone="dark" className="on-dark" />
            <TesoroLogo height={26} tone="light" className="on-light" />
          </span>
          <nav className="lp-footer-links mono" aria-label="Elsewhere">
            {LINKS.map(([label, href]) => (
              <A key={label} label={label} href={href} />
            ))}
          </nav>
          {!f.strip && testnet && <p className="mono lp-footer-stage">test mode · no real value</p>}
        </div>
      )}
      {f.strip && (
        <div className="lp-wrap">
          <div className="fp-strip mono">
            <span className="fp-fair">Fair play · every result on record</span>
            {testnet && <span className="fp-test">Test mode · simulated yield · no real value</span>}
            <span>© 2026 Gemstone Labs</span>
          </div>
        </div>
      )}
      <PrototypeSwitcher variants={VARIANTS} />
    </footer>
  );
}
