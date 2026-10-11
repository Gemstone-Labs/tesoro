"use client";

import Link from "next/link";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { FooterA, FooterB, FooterC, FooterD } from "./SiteFooter.prototype";

const VARIANTS = [
  { key: "A", name: "Directory" },
  { key: "B", name: "Sign-off" },
  { key: "C", name: "Last call" },
  { key: "D", name: "Instrument strip" },
  { key: "now", name: "Current" },
] as const;

/** One quiet line: the fair-play note and the simulated-yield label on the left, links on the right. */
function Current() {
  return (
    <footer className="site-foot">
      <p>
        <span>Fair play · every result on record</span>
        <i aria-hidden="true">·</i>
        <span>Test mode · simulated yield · 1 month = 10 min</span>
      </p>
      <nav aria-label="Footer">
        <Link href="/wallet">Wallet</Link>
        <Link href="/backing">Backing</Link>
        <Link href="/help">Help</Link>
        <Link href="/docs">Docs</Link>
        <span aria-disabled="true" title="Coming soon">Legal</span>
      </nav>
    </footer>
  );
}

export function SiteFooter() {
  const v = usePrototypeVariant(VARIANTS.map((x) => x.key));
  return (
    <>
      {v === "A" && <FooterA />}
      {v === "B" && <FooterB />}
      {v === "C" && <FooterC />}
      {v === "D" && <FooterD />}
      {v === "now" && <Current />}
      <PrototypeSwitcher variants={VARIANTS} />
    </>
  );
}
