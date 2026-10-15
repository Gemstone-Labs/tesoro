import Link from "next/link";
import type { ReactNode } from "react";
import { TesoroLogo } from "@/components/brand";
import { ENTITY } from "@/lib/legal/entity";

/** A plain reading page for the Terms and the Privacy Policy, in the docs' type and themes. */
export function LegalPage({ title, lede, children }: { title: string; lede: string; children: ReactNode }) {
  return (
    <div className="docs">
      <header className="docs-top">
        <div className="docs-top-in">
          <Link href="/welcome" aria-label="Tesoro, home">
            <TesoroLogo height={26} tone="dark" className="on-dark" />
            <TesoroLogo height={26} tone="light" className="on-light" />
          </Link>
        </div>
      </header>
      <main className="legal-main">
        <article className="docs-article">
          <header className="docs-head">
            <p className="docs-eyebrow">Legal</p>
            <h1 className="docs-h1">{title}</h1>
            <p className="docs-lede">{lede}</p>
            <p className="legal-date mono">Effective {ENTITY.effectiveDate}</p>
          </header>
          <div className="docs-prose">{children}</div>
          <nav className="legal-links" aria-label="Legal">
            <Link href="/terms">Terms of Service</Link>
            <Link href="/privacy">Privacy Policy</Link>
            <Link href="/docs/risks">Risks and limits</Link>
          </nav>
        </article>
      </main>
    </div>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <>
      <h2 id={id} className="docs-h2">
        {title}
      </h2>
      {children}
    </>
  );
}
