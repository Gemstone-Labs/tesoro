import Link from "next/link";
import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";

/** A titled Lobby section: a condensed header, an optional "See all" link, then a calm grid. One job per section. */
export function Rail({
  id,
  title,
  viewAll,
  cols,
  children,
  aside,
  lead,
  className,
}: {
  id: string;
  title: string;
  viewAll?: string;
  /** Columns on wide screens (fewer on narrower containers, see lobby.css). */
  cols: 2 | 3;
  children: ReactNode;
  /** Extra header content (e.g. an active-filter note). */
  aside?: ReactNode;
  /** Content between the header and the grid (e.g. the category filter). */
  lead?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rail ${className ?? ""}`} aria-labelledby={`${id}-h`} id={id} data-cols={cols}>
      <header className="rail-head">
        <h2 id={`${id}-h`} className="h-section">{title}</h2>
        {aside}
        {viewAll && (
          <Link href={viewAll} className="rail-link">
            See all <ArrowRight aria-hidden="true" />
          </Link>
        )}
      </header>
      {lead}
      <div className="rail-track">{children}</div>
    </section>
  );
}
