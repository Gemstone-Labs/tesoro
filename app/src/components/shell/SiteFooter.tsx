import Link from "next/link";

/** One quiet line: the fair-play note and the simulated-yield label on the left, links on the right. */
export function SiteFooter() {
  return (
    <footer className="site-foot">
      <p>
        <span>Fair play · on-chain</span>
        <i aria-hidden="true">·</i>
        <span>Simulated yield · 1 month = 10 min · devnet</span>
      </p>
      <nav aria-label="Footer">
        <Link href="/wallet">Wallet</Link>
        <Link href="/backing">Backing</Link>
        <Link href="/help">Help</Link>
        <span aria-disabled="true" title="Coming soon">Docs</span>
        <span aria-disabled="true" title="Coming soon">Legal</span>
      </nav>
    </footer>
  );
}
