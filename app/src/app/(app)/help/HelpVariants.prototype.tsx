"use client";

/**
 * PROTOTYPE, throwaway. Four takes on the Help page on the real /help route, switched by `?variant=`:
 * now (main), A Ask (search first), B Manual (two-pane, every answer open), C Loop (questions hung on the
 * money loop), D Triage (New here / Something stuck doors, answers in a sheet). Same copy in all of them.
 */
import Link from "next/link";
import { isValidElement, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowRight, ChevronDown, Gem, Hourglass, RefreshCw, Search, Send, TrendingUp, UserX, WifiOff, X,
} from "lucide-react";
import { Bust, BustCard, Button, Sheet } from "@/components/ui";
import { PrototypeSwitcher, usePrototypeVariant } from "@/components/prototype/PrototypeSwitcher";
import { STEPS, TOPICS } from "./help-content";
import "./help.prototype.css";

const VARIANTS = [
  { key: "now", name: "Current" },
  { key: "A", name: "Ask: search first" },
  { key: "B", name: "Manual: two panes" },
  { key: "C", name: "Loop: by step" },
  { key: "D", name: "Triage: two doors" },
] as const;
type Key = (typeof VARIANTS)[number]["key"];

type Q = { q: string; a: ReactNode; topic: string; topicId: string };
const ALL: Q[] = TOPICS.flatMap((t) => t.qs.map((x) => ({ ...x, topic: t.title, topicId: t.id })));
const byQ = (q: string) => ALL.find((x) => x.q === q)!;

function textOf(n: ReactNode): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join(" ");
  if (isValidElement<{ children?: ReactNode }>(n)) return textOf(n.props.children);
  return "";
}

export function HelpPrototype({ now }: { now: ReactNode }) {
  const v = usePrototypeVariant<Key>(VARIANTS.map((x) => x.key));
  return (
    <>
      {v === "now" && now}
      {v === "A" && <VariantA />}
      {v === "B" && <VariantB />}
      {v === "C" && <VariantC />}
      {v === "D" && <VariantD />}
      <PrototypeSwitcher variants={VARIANTS} />
    </>
  );
}

function Accordion({ q, a, meta, open }: { q: ReactNode; a: ReactNode; meta?: string; open?: boolean }) {
  return (
    <details className="cut cut-card help-q" open={open}>
      <summary>
        <span className="pa-q">
          {q}
          {meta && <span className="label">{meta}</span>}
        </span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="help-a">{a}</div>
    </details>
  );
}

/* ——— A · Ask: one search box over every answer, topics as filters, the steps as a quiet strip ——— */

const POPULAR = ["Can I lose my Principal in a Match?", "Why are the Gemas I won Pending?", "How does a Match work?", "What are the Fees?", "Is this real money?"];

function Highlight({ text, term }: { text: string; term: string }) {
  if (!term) return <>{text}</>;
  const i = text.toLowerCase().indexOf(term.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + term.length)}</mark>
      {text.slice(i + term.length)}
    </>
  );
}

function VariantA() {
  const [term, setTerm] = useState("");
  const [topic, setTopic] = useState<string | null>(null);
  const t = term.trim().toLowerCase();
  const hits = useMemo(
    () => ALL.filter((x) => (!topic || x.topicId === topic) && (!t || `${x.q} ${textOf(x.a)}`.toLowerCase().includes(t))),
    [t, topic],
  );

  return (
    <div className="pa">
      <section className="cut cut-frame pa-hero">
        <div className="pa-hero-text">
          <span className="label">Help</span>
          <h1 className="page-title">What do you need help with?</h1>
          <label className="cut cut-btn search pa-search">
            <Search aria-hidden="true" />
            <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search: Debt, Pending, Fees, Hold'em…" aria-label="Search Help" />
            {term && (
              <button type="button" className="search-clear" onClick={() => setTerm("")} aria-label="Clear">
                <X />
              </button>
            )}
          </label>
          <div className="pa-popular">
            <span className="meta">People ask:</span>
            {POPULAR.map((p) => (
              <button key={p} type="button" className="pa-pop" onClick={() => setTerm(p.replace(/\?$/, ""))}>
                {p}
              </button>
            ))}
          </div>
        </div>
        <Bust name="himExplain" width={250} className="pa-bust" />
      </section>

      <ol className="pa-steps" aria-label="How Tesoro works">
        {STEPS.map((s, i) => (
          <li key={s.title}>
            <Link href={s.href}>
              <span className="pa-step-n">{i + 1}</span>
              <span>
                <b>{s.title}</b>
                <span className="meta">{s.text}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>

      <div className="pa-filters" role="group" aria-label="Topics">
        <button type="button" className="cut chip" aria-pressed={!topic} onClick={() => setTopic(null)}>
          All <span className="pa-count">{ALL.length}</span>
        </button>
        {TOPICS.map((x) => (
          <button key={x.id} type="button" className="cut chip" aria-pressed={topic === x.id} onClick={() => setTopic(topic === x.id ? null : x.id)}>
            {x.title} <span className="pa-count">{x.qs.length}</span>
          </button>
        ))}
      </div>

      <p className="meta" aria-live="polite">
        {t ? `${hits.length} ${hits.length === 1 ? "answer" : "answers"} for “${term.trim()}”` : `${hits.length} questions`}
      </p>

      {hits.length ? (
        <div className="help-qs">
          {hits.map((x) => (
            <Accordion key={x.q} q={<Highlight text={x.q} term={term.trim()} />} a={x.a} meta={topic ? undefined : x.topic} open={!!t && hits.length <= 3} />
          ))}
        </div>
      ) : (
        <BustCard bust="himLose" size={100}>
          <b>Nothing matches that</b>
          <p>Try a shorter word, or look in the Docs, which go deeper on every rule.</p>
          <div className="help-still">
            <Button size="sm" onClick={() => setTerm("")}>Clear search</Button>
            <Button size="sm" href="/docs">Docs</Button>
          </div>
        </BustCard>
      )}
    </div>
  );
}

/* ——— B · Manual: sticky contents rail on the left, every answer open on the right, read like a page ——— */

function VariantB() {
  const [active, setActive] = useState("start");

  useEffect(() => {
    const els = ["start", ...TOPICS.map((t) => t.id)].map((id) => document.getElementById(`pb-${id}`)).filter(Boolean) as HTMLElement[];
    const io = new IntersectionObserver(
      (es) => {
        const vis = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (vis) setActive(vis.target.id.slice(3));
      },
      { rootMargin: "-100px 0px -60% 0px" },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, []);

  return (
    <div className="pb">
      <nav className="pb-rail" aria-label="Help contents">
        <span className="label">On this page</span>
        <a href="#pb-start" aria-current={active === "start" ? "true" : undefined} className="pb-top">How it works</a>
        {TOPICS.map((t) => (
          <div key={t.id} className="pb-group">
            <a href={`#pb-${t.id}`} aria-current={active === t.id ? "true" : undefined} className="pb-top">
              {t.title}
            </a>
            {active === t.id && (
              <ul>
                {t.qs.map((x, i) => (
                  <li key={x.q}>
                    <a href={`#pb-${t.id}-${i}`}>{x.q}</a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <div className="pb-rail-foot">
          <span className="meta">Need the full rules?</span>
          <Link href="/docs">
            Read the Docs <ArrowRight aria-hidden="true" />
          </Link>
        </div>
      </nav>

      <article className="pb-body">
        <header>
          <h1 className="page-title">Help</h1>
          <p className="page-sub">How Tesoro works, and what to do when something gets stuck.</p>
        </header>

        <section id="pb-start" className="pb-section">
          <h2 className="h-section">How it works</h2>
          <ol className="cut cut-frame pb-flow">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="label">Step {i + 1}</span>
                <b>{s.title}</b>
                <p>{s.text}</p>
                <Link href={s.href}>
                  {s.cta} <ArrowRight aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ol>
        </section>

        {TOPICS.map((t) => (
          <section key={t.id} id={`pb-${t.id}`} className="pb-section">
            <h2 className="h-section">{t.title}</h2>
            {t.qs.map((x, i) => (
              <div key={x.q} id={`pb-${t.id}-${i}`} className="pb-qa">
                <h3>{x.q}</h3>
                <div className="help-a">{x.a}</div>
              </div>
            ))}
          </section>
        ))}
      </article>
    </div>
  );
}

/* ——— C · Loop: the money loop is the page; pick a station and see only its questions ——— */

const STATIONS: { id: string; n?: number; title: string; line: string; href?: string; cta?: string; qs: string[] }[] = [
  {
    id: "lock", n: 1, title: "Open a Position", line: "Lock a staking token in your Wallet. Its Principal is never played.", href: "/wallet", cta: "Open a Position",
    qs: ["Can I lose my Principal in a Match?", "What is the Unlock Estimate?", "How do I get my Principal back?"],
  },
  {
    id: "advance", n: 2, title: "Take an Advance", line: "Get its projected yield for 1–12 months upfront, as Gemas. Your yield repays the Debt.", href: "/wallet", cta: "Take an Advance",
    qs: ["What is a Gema?", "Where do my Gemas come from?", "How is my Debt repaid?", "Can I take another Advance?"],
  },
  {
    id: "play", n: 3, title: "Play a Match", line: "Pick a game and an entry. Win the Pot minus Fees.", href: "/play", cta: "Play",
    qs: TOPICS.find((t) => t.id === "matches")!.qs.map((x) => x.q),
  },
  {
    id: "redeem", n: 4, title: "Redeem", line: "Turn Gemas into their Source asset as its yield lands.", href: "/wallet", cta: "Redeem",
    qs: TOPICS.find((t) => t.id === "redeem")!.qs.filter((x) => x.q !== "How do I get my Principal back?").map((x) => x.q),
  },
  {
    id: "backing", title: "Backing", line: "Pay someone's entry, or get yours paid. Only the Backer can lose.", href: "/backing", cta: "Backing",
    qs: TOPICS.find((t) => t.id === "backing")!.qs.map((x) => x.q),
  },
  {
    id: "account", title: "Account and chains", line: "Sign in with email or a wallet. Testnets only.",
    qs: TOPICS.find((t) => t.id === "account")!.qs.map((x) => x.q),
  },
  {
    id: "trouble", title: "Something stuck", line: "Nothing is lost: everything is saved on the chain.",
    qs: TOPICS.find((t) => t.id === "trouble")!.qs.map((x) => x.q),
  },
];

function VariantC() {
  const [sel, setSel] = useState("lock");
  const st = STATIONS.find((s) => s.id === sel)!;
  const loop = STATIONS.filter((s) => s.n);
  const side = STATIONS.filter((s) => !s.n);

  return (
    <div className="pc">
      <header className="page-head">
        <div>
          <h1 className="page-title">Help</h1>
          <p className="page-sub">Tesoro is one loop. Pick a step to see what people ask about it.</p>
        </div>
      </header>

      <div className="cut cut-frame pc-loop" role="tablist" aria-label="Steps">
        {loop.map((s, i) => (
          <div key={s.id} className="pc-node-wrap">
            <button type="button" role="tab" aria-selected={sel === s.id} className="cut cut-card pc-node" onClick={() => setSel(s.id)}>
              <span className="pc-n">{s.n}</span>
              <b>{s.title}</b>
              <span className="meta">{s.qs.length} questions</span>
            </button>
            {i < loop.length - 1 && <ArrowRight className="pc-arrow" aria-hidden="true" />}
          </div>
        ))}
        <p className="pc-back meta">
          <RefreshCw aria-hidden="true" /> Your yield repays the Debt. At zero, Unlock gets your Principal back, or take a new Advance.
        </p>
      </div>

      <div className="pc-side" role="tablist" aria-label="More help">
        {side.map((s) => (
          <button key={s.id} type="button" role="tab" aria-selected={sel === s.id} className="cut cut-btn pc-side-btn" onClick={() => setSel(s.id)}>
            {s.title} <span className="pa-count">{s.qs.length}</span>
          </button>
        ))}
      </div>

      <section className="pc-panel" role="tabpanel" aria-labelledby={`pc-${st.id}`}>
        <div className="pc-panel-head">
          <div>
            {st.n && <span className="label">Step {st.n} of 4</span>}
            <h2 id={`pc-${st.id}`} className="h-section">{st.title}</h2>
            <p className="page-sub">{st.line}</p>
          </div>
          {st.href && <Button href={st.href}>{st.cta} <ArrowRight aria-hidden="true" /></Button>}
        </div>
        <div className="help-qs">
          {st.qs.map((q, i) => (
            <Accordion key={q} q={q} a={byQ(q).a} open={i === 0} />
          ))}
        </div>
      </section>
    </div>
  );
}

/* ——— D · Triage: two doors up top (New here / Something stuck), every other question as an index, answers in a sheet ——— */

const SYMPTOMS: { q: string; short: string; icon: ReactNode; action?: { label: string; href?: string; reload?: boolean } }[] = [
  { q: "My ETH or HYPE Position is still crossing chains", short: "Still crossing chains", icon: <Hourglass />, action: { label: "Open Wallet", href: "/wallet" } },
  { q: "It says I don't have enough Gemas", short: "Not enough Gemas", icon: <Gem />, action: { label: "Open Wallet", href: "/wallet" } },
  { q: "My ETH or HYPE Position shows yield that is not reported", short: "Yield not reported", icon: <Send />, action: { label: "Open Wallet", href: "/wallet" } },
  { q: "It says the price is updating", short: "Price is updating", icon: <TrendingUp /> },
  { q: "A page won’t load", short: "A page won’t load", icon: <WifiOff />, action: { label: "Refresh the page", reload: true } },
  { q: "My opponent never showed up", short: "Opponent never showed", icon: <UserX />, action: { label: "Your Matches", href: "/matches" } },
];

function VariantD() {
  const [openQ, setOpenQ] = useState<string | null>(null);
  const [fix, setFix] = useState(SYMPTOMS[0].q);
  const sym = SYMPTOMS.find((s) => s.q === fix)!;
  const shown = openQ ? byQ(openQ) : null;

  return (
    <div className="pd">
      <header className="page-head">
        <div>
          <h1 className="page-title">Help</h1>
          <p className="page-sub">Start here if you are new. Jump right if something is stuck.</p>
        </div>
      </header>

      <div className="pd-doors">
        <section className="cut cut-frame pd-door pd-new" aria-labelledby="pd-new-h">
          <div className="pd-door-head">
            <span className="label">New here</span>
            <h2 id="pd-new-h" className="display">Four steps</h2>
          </div>
          <ol className="pd-steps">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="pd-n">{i + 1}</span>
                <div>
                  <b>{s.title}</b>
                  <p className="meta">{s.text}</p>
                </div>
                <Link href={s.href} className="pd-go" aria-label={`${s.cta}: ${s.title}`}>
                  <ArrowRight />
                </Link>
              </li>
            ))}
          </ol>
          <Bust name="himWelcome" width={150} className="pd-bust" />
        </section>

        <section className="cut cut-frame pd-door pd-stuck" aria-labelledby="pd-stuck-h">
          <div className="pd-door-head">
            <span className="label">Something stuck</span>
            <h2 id="pd-stuck-h" className="display">What do you see?</h2>
          </div>
          <div className="pd-symptoms" role="tablist" aria-label="Symptoms">
            {SYMPTOMS.map((s) => (
              <button key={s.q} type="button" role="tab" aria-selected={fix === s.q} className="cut cut-btn pd-sym" onClick={() => setFix(s.q)}>
                {s.icon}
                {s.short}
              </button>
            ))}
          </div>
          <div className="cut cut-card pd-fix" role="tabpanel">
            <b>{sym.q}</b>
            <div className="help-a">{byQ(sym.q).a}</div>
            {sym.action &&
              (sym.action.reload ? (
                <Button size="sm" onClick={() => window.location.reload()}>
                  <RefreshCw /> {sym.action.label}
                </Button>
              ) : (
                <Button size="sm" href={sym.action.href}>
                  {sym.action.label} <ArrowRight />
                </Button>
              ))}
          </div>
        </section>
      </div>

      <section className="pd-index" aria-labelledby="pd-index-h">
        <h2 id="pd-index-h" className="h-section">Every question</h2>
        <div className="pd-cols">
          {TOPICS.filter((t) => t.id !== "trouble").map((t) => (
            <div key={t.id} className="pd-col">
              <span className="label">{t.title}</span>
              <ul>
                {t.qs.map((x) => (
                  <li key={x.q}>
                    <button type="button" onClick={() => setOpenQ(x.q)}>
                      {x.q}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <BustCard bust="himExplain" size={110}>
        <b>Still stuck?</b>
        <p>Your Positions, Gemas and Matches are read from the chain, so nothing is lost. Your Match history shows every settled and refunded Match.</p>
        <div className="help-still">
          <Button size="sm" href="/matches">Match history</Button>
          <Button size="sm" href="/docs">Docs</Button>
        </div>
      </BustCard>

      <Sheet open={!!shown} onClose={() => setOpenQ(null)} title={shown?.q ?? ""}>
        {shown && (
          <div className="pd-sheet">
            <span className="label">{shown.topic}</span>
            <div className="help-a">{shown.a}</div>
          </div>
        )}
      </Sheet>
    </div>
  );
}
