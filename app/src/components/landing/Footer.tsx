import { TesoroLogo } from "@/components/brand";
import { LAUNCH_STAGE, OUTBOUND } from "@/lib/landing/config";

const LINKS = [
  ["Docs", OUTBOUND.docs],
  ["Terms", "/terms"],
  ["Privacy", "/privacy"],
  ["X", OUTBOUND.x],
  ["GitHub", OUTBOUND.github],
] as const;

export function Footer() {
  return (
    <footer className="lp-footer">
      <div className="lp-wrap lp-footer-in">
        <span className="lp-logo">
          <TesoroLogo height={26} tone="dark" className="on-dark" />
          <TesoroLogo height={26} tone="light" className="on-light" />
        </span>
        <nav className="lp-footer-links mono" aria-label="Elsewhere">
          {LINKS.map(([label, href]) =>
            href ? (
              <a key={label} href={href} rel="noopener">
                {label}
              </a>
            ) : (
              <span key={label} className="lp-dim" aria-disabled="true" title="Coming soon">
                {label}
              </span>
            ),
          )}
        </nav>
        {LAUNCH_STAGE === "testnet" && <p className="mono lp-footer-stage">test mode · no real value</p>}
      </div>
    </footer>
  );
}
