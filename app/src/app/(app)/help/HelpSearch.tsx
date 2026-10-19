"use client";

import { isValidElement, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, Search, X } from "lucide-react";
import { BustCard, Button } from "@/components/ui";
import { TOPICS } from "./help-content";

const ALL = TOPICS.flatMap((t) => t.qs.map((x) => ({ ...x, topic: t.title })));

function textOf(n: ReactNode): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(" ");
  if (isValidElement<{ children?: ReactNode }>(n)) return textOf(n.props.children);
  return "";
}

const INDEX = ALL.map((x) => `${x.q} ${textOf(x.a)}`.toLowerCase());

function Highlight({ text, term }: { text: string; term: string }) {
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + term.length)}</mark>
      {text.slice(i + term.length)}
    </>
  );
}

/** One search box over every question and answer. While it has text, the matches replace `children` (the browsable page). */
export function HelpSearch({ children }: { children: ReactNode }) {
  const [value, setValue] = useState("");
  const term = value.trim();
  const hits = useMemo(() => {
    const t = term.toLowerCase();
    return t ? ALL.filter((_, i) => INDEX[i].includes(t)) : [];
  }, [term]);

  return (
    <>
      <label className="cut cut-btn search help-search">
        <Search aria-hidden="true" />
        <input
          type="search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setValue("")}
          placeholder="Search: Locks, Fees, Hold'em…"
          aria-label="Search Help"
        />
        {value && (
          <button type="button" className="search-clear" onClick={() => setValue("")} aria-label="Clear search">
            <X />
          </button>
        )}
      </label>

      {term ? (
        <section aria-label="Search results" className="help-section">
          <p className="meta" aria-live="polite">
            {hits.length} {hits.length === 1 ? "answer" : "answers"} for “{term}”
          </p>
          {hits.length ? (
            <div className="help-qs">
              {hits.map(({ q, a, topic }) => (
                <details key={q} className="cut cut-card help-q" open={hits.length <= 3}>
                  <summary>
                    <span className="help-hit">
                      <span>
                        <Highlight text={q} term={term} />
                      </span>
                      <span className="label">{topic}</span>
                    </span>
                    <ChevronDown aria-hidden="true" />
                  </summary>
                  <div className="help-a">{a}</div>
                </details>
              ))}
            </div>
          ) : (
            <BustCard bust="himLose" size={100}>
              <b>Nothing matches that</b>
              <p>Try a shorter word, or look in the Docs, which go deeper on every rule.</p>
              <div className="help-still">
                <Button size="sm" onClick={() => setValue("")}>Clear search</Button>
                <Button size="sm" href="/docs">Docs</Button>
              </div>
            </BustCard>
          )}
        </section>
      ) : (
        children
      )}
    </>
  );
}
