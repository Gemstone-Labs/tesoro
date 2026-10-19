import { Link2 } from "lucide-react";
import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton";
import { TocInline } from "./TocRail";
import { groupOf, neighbours, ALL_PAGES } from "./nav";
import Link from "next/link";
import { ArrowLeft, ArrowRight, TriangleAlert } from "lucide-react";

/** A heading with an anchor. `id` is the URL fragment. */
export function H2({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h2 id={id} className="docs-h2">
      <a href={`#${id}`} className="docs-anchor" aria-label={`Link to ${typeof children === "string" ? children : "this section"}`}>
        <Link2 aria-hidden />
      </a>
      {children}
    </h2>
  );
}

export function H3({ id, children }: { id: string; children: ReactNode }) {
  return (
    <h3 id={id} className="docs-h3">
      <a href={`#${id}`} className="docs-anchor" aria-label={`Link to ${typeof children === "string" ? children : "this section"}`}>
        <Link2 aria-hidden />
      </a>
      {children}
    </h3>
  );
}

/** Inline label for anything simulated. */
export function Sim({ children = "Simulated" }: { children?: ReactNode }) {
  return <span className="docs-sim">{children}</span>;
}

export function Callout({ kind = "note", title, children }: { kind?: "note" | "sim" | "warn"; title?: string; children: ReactNode }) {
  return (
    <aside className={`docs-callout cut cut-card is-${kind}`} role="note">
      {title && (
        <b className="docs-callout-title">
          {kind === "warn" && <TriangleAlert aria-hidden />}
          {title}
        </b>
      )}
      <div>{children}</div>
    </aside>
  );
}

/** A plain data table that scrolls sideways on a phone instead of breaking the page. */
export function DataTable({ head, rows, caption }: { head: ReactNode[]; rows: ReactNode[][]; caption?: string }) {
  return (
    <div className="docs-table" tabIndex={0} role="region" aria-label={caption ?? "Table"}>
      <table>
        {caption && <caption>{caption}</caption>}
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j}>{c}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A block of code or a command, with a copy button. */
export function Code({ children, label }: { children: string; label?: string }) {
  const text = children.replace(/\n$/, "");
  return (
    <figure className="docs-code cut cut-card">
      <figcaption>
        <span>{label ?? ""}</span>
        <CopyButton value={text} />
      </figcaption>
      <pre tabIndex={0}>
        <code>{text}</code>
      </pre>
    </figure>
  );
}

/** One address or id: a label, the value in mono with a copy button, and an optional explorer link. */
export function Addr({ label, value, href, note }: { label: string; value: string; href?: string; note?: ReactNode }) {
  return (
    <div className="docs-addr">
      <div className="docs-addr-label">{label}</div>
      <div className="docs-addr-row">
        <code>{value}</code>
        <CopyButton value={value} label={`Copy ${label}`} />
        {href && (
          <a href={href} rel="noopener noreferrer" target="_blank" className="docs-ext">
            Explorer
          </a>
        )}
      </div>
      {note && <div className="docs-addr-note">{note}</div>}
    </div>
  );
}

export const explorer = (addr: string) => `https://explorer.solana.com/address/${addr}?cluster=devnet`;
export const hoodi = (addr: string) => `https://hoodi.etherscan.io/address/${addr}`;
export const purrsec = (addr: string) => `https://testnet.purrsec.com/address/${addr}`;

/** Numbered steps with a big figure on the left. */
export function Steps({ items }: { items: { title: string; body: ReactNode }[] }) {
  return (
    <ol className="docs-steps">
      {items.map((s, i) => (
        <li key={s.title}>
          <span className="docs-step-n" aria-hidden>
            {i + 1}
          </span>
          <div>
            <b>{s.title}</b>
            <p>{s.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/** The page frame: group label, title, summary, an optional hero visual, body, then previous and next. */
export function DocPage({ href, hero, children }: { href: string; hero?: ReactNode; children: ReactNode }) {
  const page = ALL_PAGES.find((p) => p.href === href);
  const group = groupOf(href);
  const { prev, next } = neighbours(href);
  if (!page) throw new Error(`Unknown doc page ${href}`);
  return (
    <article className="docs-article">
      <header className="docs-head">
        <p className="docs-eyebrow">{group?.label}</p>
        <h1 className="docs-h1">{page.title}</h1>
        <p className="docs-lede">{page.summary}</p>
        <TocInline />
      </header>
      {hero && <div className="docs-hero">{hero}</div>}
      <div className="docs-prose">{children}</div>
      <nav className="docs-pager" aria-label="Previous and next">
        {prev ? (
          <Link href={prev.href} rel="prev" className="cut cut-card docs-pager-link">
            <span><ArrowLeft aria-hidden /> Previous</span>
            <b>{prev.title}</b>
          </Link>
        ) : (
          <span />
        )}
        {next ? (
          <Link href={next.href} rel="next" className="cut cut-card docs-pager-link next">
            <span>Next <ArrowRight aria-hidden /></span>
            <b>{next.title}</b>
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </article>
  );
}
