"use client";

import { GetGemasButton } from "@/components/deposit/GetGemasButton";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { GameTabs, HistoryPages, ResultFilter, gameFilter, historyHref, resultCounts } from "@/components/match/MatchHistory";
import { MatchBanner } from "@/components/match/MatchBanner";
import { ChallengeSheet } from "@/components/match/ChallengeSheet";
import { Bust, Button, Notice } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { accountKeyOf, parseAccountKey } from "@/lib/chain/account-key";
import { RESULTS, historyPage, resultFilter } from "@/lib/chain/history";
import { backingLine, summaryOfRows, topGames, type PlayerAccount } from "@/lib/chain/player-account";
import { usePlayerAccount } from "@/lib/chain/usePlayerAccount";
import { GAME_NAMES } from "@/lib/mock";
import { AccountHero } from "./AccountHero";
import { AccountSkeleton } from "./AccountSkeleton";
import { shownIdentity } from "@/lib/identity/display";
import { useIdentity } from "@/lib/identity/store";
import { GemasPanel } from "./GemasPanel";
import { Protections } from "./Protections";
import { RecentMatches } from "./RecentMatches";
import "./account.css";
import { BRAND } from "@/lib/brand";

/**
 * A Player's Account as anyone may see it: the Matches it played, the Gemas it won and lost, the
 * Backings it played under and what they did for the Backers. No balances and no Positions.
 * `address` is the Account key from the URL; a wallet address is sent on to the Account it owns.
 */
export function AccountView({ address }: { address: string }) {
  const parsed = useMemo(() => parseAccountKey(address), [address]);
  const router = useRouter();
  const key = parsed && !parsed.fromWallet ? parsed.key.toBase58() : null;
  const owned = parsed?.fromWallet ? parsed.key.toBase58() : null;
  useEffect(() => {
    if (owned) router.replace(`/account/${owned}`);
  }, [owned, router]);
  const { data, error, refresh } = usePlayerAccount(key);

  if (!parsed) return <Notice title="Account not found" body="That address is not an Account key." />;
  if (!key) return <Notice title="Account" body="Finding the Account of this wallet…" />;
  if (!data) {
    return error ? (
      <div className="pa">
        <h1 className="page-title">Account</h1>
        <div className="mh-state" role="alert">
          <p>This Account couldn’t be loaded.</p>
          <Button size="sm" onClick={refresh}>Try again</Button>
        </div>
      </div>
    ) : (
      <AccountSkeleton />
    );
  }
  return <Loaded address={key} data={data} stale={!!error} />;
}

function Loaded({ address, data, stale }: { address: string; data: PlayerAccount; stale: boolean }) {
  const { auth, snapshot, gemas } = useAccount();
  const params = useSearchParams();
  const [now] = useState(() => Date.now());
  const [challenge, setChallenge] = useState(false);

  const rows = data.rows;
  const summary = useMemo(() => summaryOfRows(rows), [rows]);
  const game = gameFilter(params.get("game"));
  const results = resultFilter(params.get("result"));
  const ofGame = game ? rows.filter((r) => r.game === game) : rows;
  const shown = ofGame.filter((r) => results.includes(r.result));
  const view = historyPage(shown, Number(params.get("page") ?? 1));
  const base = `/account/${address}`;
  // The full history (filters, pages) opens from "See all" and whenever a filter or page is in the address.
  const [expanded, setExpanded] = useState(false);
  const showAll = expanded || params.has("game") || params.has("result") || params.has("page");

  const me = snapshot?.accountKey.toBase58() ?? (auth.addresses.solana ? accountKeyOf(auth.addresses.solana) : null);
  const own = me === address;
  const visitor = !own && auth.status !== "loading";
  const identity = useIdentity(address);
  const who = shownIdentity(address, identity);
  // Registry names the title does not already show.
  const otherNames = ([[".sol", identity.sol], [".eth", identity.eth], [".hl", identity.hl]] as const).flatMap(([suffix, n]) => (n && n.name !== who.label ? [{ suffix, name: n.name }] : []));
  const played = rows.length > 0 || summary.notRead > 0;

  // Your own Account page exists before the Account does on chain (it is created with your first Position or Match).
  if (!data.exists && !own) {
    return auth.status === "loading" ? null : <Notice title="Account not found" body={`There is no ${BRAND.name} Account at this address.`} />;
  }


  return (
    <div className="pa">
      <AccountHero
        address={address}
        own={own}
        visitor={visitor}
        s={summary}
        games={topGames(rows)}
        now={now}
        otherNames={otherNames}
        requests={data.requests}
        onChallenge={() => setChallenge(true)}
      />

      {played ? <GemasPanel rows={rows} /> : <NoMatches own={own} name={who.label} hasGemas={snapshot ? gemas.total > 0 : null} />}

      {own && <Protections />}

      {played && !showAll && <RecentMatches rows={rows} now={now} allHref={own ? "/matches" : undefined} onAll={() => setExpanded(true)} />}

      {played && showAll && (
        <section className="pa-history" aria-labelledby="pa-matches">
          <header className="mh-head">
            <h2 id="pa-matches" className="h-section">Match history</h2>
            {rows.length > 0 && <GameTabs base={base} game={game} results={results} />}
            <ResultFilter base={base} game={game} results={results} counts={resultCounts(ofGame)} />
          </header>
          {ofGame.length === 0 ? (
            rows.length > 0 && <p className="pa-none">No finished {game ? GAME_NAMES[game] : ""} Matches yet.</p>
          ) : shown.length === 0 ? (
            <div className="mh-state">
              <p>No {game ? `${GAME_NAMES[game]} ` : ""}Matches with these results.</p>
              <Button size="sm" href={historyHref(base, game, 1, RESULTS)}>Show all results</Button>
            </div>
          ) : (
            <>
              <div className="mb-list" role="list" aria-label={`${game ? GAME_NAMES[game] : "All"} Matches, page ${view.page} of ${view.pages}`}>
                {view.rows.map((r) => (
                  <div key={r.id} role="listitem">
                    <MatchBanner r={r} account={address} now={now} backing={backingLine(r)} me={me} />
                  </div>
                ))}
              </div>
              <HistoryPages base={base} game={game} results={results} page={view.page} pages={view.pages} total={shown.length} />
            </>
          )}
          {summary.notRead > 0 && (
            <p className="note">
              {summary.notRead} settled {summary.notRead === 1 ? "Match" : "Matches"} could not be read and {summary.notRead === 1 ? "is" : "are"} not counted here.
            </p>
          )}
        </section>
      )}

      {stale && <p className="note">Couldn’t refresh; showing what was last loaded.</p>}
      <p className="note">Test mode · Gemas come from simulated yield and have no real value.</p>

      <ChallengeSheet open={challenge} onClose={() => setChallenge(false)} player={address} name={who.label} />
    </div>
  );
}

const SHOWN: [string, string][] = [
  ["Record", "How many Matches were won, of those with a winner."],
  ["Gemas won and lost", "After Fees, with a running total Match by Match."],
  ["Recent Matches", "The latest Matches, with the full history behind them."],
];

/**
 * No finished Match yet: what the Account will show, and for its owner the way to start (a Position
 * first when they hold no Gemas, since Gemas come from one; no button until their Gemas are read).
 */
function NoMatches({ own, name, hasGemas }: { own: boolean; name: string; hasGemas: boolean | null }) {
  return (
    <section className={`cut cut-card pa-empty${own ? "" : " quiet"}`} aria-label="No Matches yet">
      <Bust name="himWaiting" width={190} className="pa-empty-bust" />
      <div className="pa-empty-lead">
        <b>No Matches yet</b>
        <p>
          {!own
            ? `${name} has not finished a Match. When they do, their Account shows:`
            : hasGemas !== false
              ? "Play a Match and your Account fills in as it settles. This is what other Players will see:"
              : "Get Gemas in your Vault, then play a Match: your Account fills in as it settles. This is what other Players will see:"}
        </p>
      </div>
      {own &&
        hasGemas !== null &&
        (hasGemas ? (
          <Button variant="money" href="/play">
            Play now
          </Button>
        ) : (
          <GetGemasButton />
        ))}
      <ul className="pa-empty-list">
        {SHOWN.map(([title, text]) => (
          <li key={title}>
            <b>{title}</b>
            <p>{text}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
