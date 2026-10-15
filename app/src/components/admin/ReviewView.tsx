import Link from "next/link";
import { AccountLink } from "@/components/account/AccountLink";
import type { Flag, FlagKind, ReviewReply } from "@/lib/review/flags";
import "./review.css";

const KIND: Record<FlagKind, string> = {
  timing: "Move timing",
  pair: "Keeps meeting",
  "win-rate": "Win rate",
};
/** Matches listed per flag before "and N more". */
const SHOWN = 12;

const when = (secs: number) => new Date(secs * 1000).toUTCString().replace(" GMT", " UTC");

export interface ReviewViewProps {
  /** Null while it loads. */
  review: ReviewReply | null;
  error?: string | null;
  /** True when no wallet is signed in. */
  signedOut?: boolean;
}

function FlagCard({ flag }: { flag: Flag }) {
  const ids = [...flag.matchIds].reverse();
  return (
    <li className="cut cut-card rv-flag">
      <span className="cut cut-chip rv-kind">{KIND[flag.kind]}</span>
      <p className="rv-who">
        <AccountLink account={flag.account} />
        {flag.other && (
          <>
            {" "}
            <span className="meta">and</span> <AccountLink account={flag.other} />
          </>
        )}
      </p>
      <p>{flag.summary}</p>
      <p className="meta rv-matches">
        Matches:{" "}
        {ids.slice(0, SHOWN).map((id, i) => (
          <span key={id}>
            {i > 0 && ", "}
            <Link href={`/play/match/${id}`}>#{id}</Link>
          </span>
        ))}
        {ids.length > SHOWN && ` and ${ids.length - SHOWN} more`}
      </p>
    </li>
  );
}

/** Flagged Accounts for the Season in progress and the one in its 48-hour payout window. Shows nothing without the admin's data. */
export function ReviewView({ review, error = null, signedOut = false }: ReviewViewProps) {
  return (
    <div className="stack rv">
      <h1 className="page-title">Review</h1>
      <p className="meta">Flags only point at an Account. Open its page and its Matches, then decide on a void inside the payout window.</p>
      {signedOut && <p role="status">Sign in with a review wallet to see this page.</p>}
      {error && <p role="alert">{error}</p>}
      {!signedOut && !error && !review && <p role="status">Loading…</p>}
      {review?.seasons.map((s) => {
        const flags = review.flags.filter((f) => f.season === s.number);
        return (
          <section key={s.number} className="stack" aria-label={`Season ${s.number}`}>
            <h2>
              Season {s.number}{" "}
              <span className="meta">{s.phase === "current" ? "in progress" : `payout window until ${when(s.windowEnds ?? 0)}`}</span>
            </h2>
            {flags.length === 0 ? (
              <p className="meta">Nothing flagged.</p>
            ) : (
              <ul className="rv-list">
                {flags.map((f) => (
                  <FlagCard key={`${f.kind}:${f.account}:${f.other ?? ""}`} flag={f} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
