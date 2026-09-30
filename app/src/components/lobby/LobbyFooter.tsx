import Link from "next/link";
import { GemaMark } from "@/components/ui";

const Soon = ({ children }: { children: string }) => (
  <span aria-disabled="true" title="Coming soon">
    {children}
  </span>
);

export function LobbyFooter() {
  return (
    <footer className="lobby-foot">
      <Link href="/" className="wordmark foot-word">
        <GemaMark size={28} />
        Tesoro
      </Link>
      <nav className="foot-cols" aria-label="Footer">
        <div>
          <h3>Players</h3>
          <Link href="/wallet">Wallet</Link>
          <Link href="/backing">Backing</Link>
        </div>
        <div>
          <h3>Studios</h3>
          <Soon>For Creators</Soon>
          <Soon>Integration</Soon>
        </div>
        <div>
          <h3>Company</h3>
          <div className="foot-pair">
            <Soon>About Us</Soon>
            <Soon>Legal</Soon>
            <Soon>Contact</Soon>
          </div>
        </div>
      </nav>
      <p className="foot-sim">Simulated yield · 1 month = 10 min · devnet</p>
    </footer>
  );
}
