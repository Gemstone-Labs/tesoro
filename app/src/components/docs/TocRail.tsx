"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

const SELECTOR = ".docs-prose h2[id], .docs-prose h3[id]";

/** The article's headings as one string ("id|level|text" per line): a stable snapshot to compare. */
const readHeadings = () =>
  Array.from(document.querySelectorAll<HTMLElement>(SELECTOR))
    .map((h) => `${h.id}|${h.tagName === "H2" ? 2 : 3}|${h.textContent ?? ""}`)
    .join("\n");

const subscribe = (onChange: () => void) => {
  const main = document.getElementById("docs-main");
  if (!main) return () => {};
  const mo = new MutationObserver(onChange);
  mo.observe(main, { childList: true, subtree: true });
  return () => mo.disconnect();
};

/** "On this page": built from the article's own headings, with the one in view marked. */
export function TocRail() {
  const path = usePathname();
  const snapshot = useSyncExternalStore(subscribe, readHeadings, () => "");
  const [seen, setSeen] = useState<{ path: string; id: string }>({ path: "", id: "" });

  useEffect(() => {
    const heads = Array.from(document.querySelectorAll<HTMLElement>(SELECTOR));
    if (!heads.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const inView = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (inView[0]) setSeen({ path, id: inView[0].target.id });
      },
      { rootMargin: "-72px 0px -70% 0px" },
    );
    heads.forEach((h) => io.observe(h));
    return () => io.disconnect();
  }, [path, snapshot]);

  const items = snapshot ? snapshot.split("\n").map((l) => { const [id, level, ...text] = l.split("|"); return { id, level: Number(level), text: text.join("|") }; }) : [];
  const active = seen.path === path ? seen.id : "";

  if (items.length < 2) return <aside className="docs-rail" aria-hidden />;
  return (
    <aside className="docs-rail" aria-label="On this page">
      <p className="docs-nav-label">On this page</p>
      <ul>
        {items.map((i) => (
          <li key={i.id} className={`l${i.level}`}>
            <a href={`#${i.id}`} aria-current={active === i.id ? "location" : undefined}>
              {i.text}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}
