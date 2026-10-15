import type { Metadata } from "next";
import Link from "next/link";
import { ChevronDown } from "lucide-react";
import { BustCard, Button } from "@/components/ui";
import { HelpSearch } from "./HelpSearch";
import { STEPS, TOPICS } from "./help-content";
import "./help.css";
import { BRAND } from "@/lib/brand";

export const metadata: Metadata = { title: `Help · ${BRAND.name}` };

export default function HelpPage() {
  return (
    <div className="help-page">
      <header className="page-head">
        <div>
          <h1 className="page-title">Help</h1>
          <p className="page-sub">How {BRAND.name} works, and what to do when something gets stuck.</p>
        </div>
      </header>

      <HelpSearch>
        <section aria-labelledby="help-start" className="help-section">
          <h2 id="help-start" className="h-section">Start here</h2>
          <ol className="help-steps">
            {STEPS.map((s, i) => (
              <li key={s.title} className="cut cut-card help-step">
                <span className="help-step-n" aria-hidden="true">{i + 1}</span>
                <b>{s.title}</b>
                <p>{s.text}</p>
                <Link href={s.href} className="help-step-link">
                  {s.cta} <span aria-hidden="true">→</span>
                </Link>
              </li>
            ))}
          </ol>
        </section>

        <nav aria-label="Help topics" className="help-topics">
          {TOPICS.map((t) => (
            <a key={t.id} href={`#${t.id}`} className="cut chip">
              {t.title}
            </a>
          ))}
        </nav>

        {TOPICS.map((t) => (
          <section key={t.id} id={t.id} aria-labelledby={`${t.id}-h`} className="help-section">
            <h2 id={`${t.id}-h`} className="h-section">{t.title}</h2>
            <div className="help-qs">
              {t.qs.map(({ q, a }) => (
                <details key={q} className="cut cut-card help-q">
                  <summary>
                    {q}
                    <ChevronDown aria-hidden="true" />
                  </summary>
                  <div className="help-a">{a}</div>
                </details>
              ))}
            </div>
          </section>
        ))}

        <BustCard bust="himExplain" size={110}>
          <b>Still stuck?</b>
          <p>
            Refresh the page or sign in on another device: your Positions, Gemas and Matches are read from the chain, so nothing is lost. Your
            Match history shows every settled and refunded Match.
          </p>
          <div className="help-still">
            <Button size="sm" href="/matches">Match history</Button>
            <Button size="sm" href="/wallet">Wallet</Button>
            <Button size="sm" href="/docs">Docs</Button>
          </div>
        </BustCard>
      </HelpSearch>
    </div>
  );
}
