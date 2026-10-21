"use client";

import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { GameTabs, HistoryPages, gameFilter } from "@/components/match/MatchHistory";
import { MatchBanner } from "@/components/match/MatchBanner";
import { AssetPicker, Bust, Button, EntryPicker, Label, Sheet, Notice } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import { accountKeyOf, parseAccountKey } from "@/lib/chain/account-key";
import { historyPage } from "@/lib/chain/history";
import { backingLine, playedRows, playerSummary, signed, type PlayedRow, type PlayerAccount, type PlayerSummary } from "@/lib/chain/player-account";
import { timeLeft } from "@/lib/chain/useBackingBoard";
import { usePlayerAccount } from "@/lib/chain/usePlayerAccount";
import { fmtGemas } from "@/lib/format";
import { gameQuery } from "@/lib/game-params";
import { GAME_NAMES } from "@/lib/mock";
import type { EntrySize, GameId } from "@/lib/mock";
import { AccountHero } from "./AccountHero";
import { AccountSkeleton } from "./AccountSkeleton";
import { shownIdentity } from "@/lib/identity/display";
import { useIdentity } from "@/lib/identity/store";
import { GemasPanel } from "./GemasPanel";
import "./account.css";
import { BRAND } from "@/lib/brand";
import { GAME_LIST } from "@/lib/games";

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

  const rows = useMemo(() => playedRows(data.played), [data.played]);
  const summary = useMemo(() => playerSummary(data.played), [data.played]);
  const game = gameFilter(params.get("game"));
  const shown = game ? rows.filter((r) => r.game === game) : rows;
  const view = historyPage(shown, Number(params.get("page") ?? 1));
  const base = `/account/${address}`;

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
        now={now}
        otherNames={otherNames}
        asking={data.requests.length}
        onChallenge={() => setChallenge(true)}
      />

      {visitor && data.requests.length > 0 && (
        <section className="cut cut-card pa-asks" aria-labelledby="pa-asks">
          <div className="pa-asks-lead">
            <h2 id="pa-asks" className="pa-h">Asking to be backed</h2>
            <p>You fund the whole entry and choose the share of the surplus you offer.</p>
          </div>
          <ul>
            {data.requests.map((r) => (
              <li key={r.address.toBase58()}>
                <span>
                  <b>{GAME_NAMES[r.game]}</b>
                  <small>
                    Entry {fmtGemas(r.entry)} Gemas · {timeLeft(r.expiresAt, now)}
                  </small>
                </span>
                <Button variant="money" href={`/backing#${r.address.toBase58()}`}>
                  Make an Offer
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {played ? (
        <Scoreboard s={summary} rows={rows} />
      ) : (
        <NoMatches own={own} name={who.label} hasGemas={snapshot ? gemas.total > 0 : null} />
      )}

      {played && (
        <section className="pa-history" aria-labelledby="pa-matches">
          <header className="mh-head">
            <h2 id="pa-matches" className="h-section">Match history</h2>
            {rows.length > 0 && <GameTabs base={base} game={game} />}
          </header>
          {shown.length === 0 ? (
            rows.length > 0 && <p className="pa-none">No finished {game ? GAME_NAMES[game] : ""} Matches yet.</p>
          ) : (
            <>
              <div className="mb-list" role="list" aria-label={`${game ? GAME_NAMES[game] : "All"} Matches, page ${view.page} of ${view.pages}`}>
                {view.rows.map((r) => (
                  <div key={r.id} role="listitem">
                    <MatchBanner r={r} account={address} now={now} backing={backingLine(r)} me={me} />
                  </div>
                ))}
              </div>
              <HistoryPages base={base} game={game} page={view.page} pages={view.pages} total={shown.length} />
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

      <ChallengeSheet open={challenge} onClose={() => setChallenge(false)} player={who.label} />
    </div>
  );
}

const pct = (wins: number, of: number) => Math.round((wins / of) * 100);

/**
 * The figures. Gemas won and lost lead, with the running total inside the same panel; Matches and
 * Backings sit beside it. Every rate carries its sample size, and the Player's Gemas are never
 * shown without their Backers'.
 */
function Scoreboard({ s, rows }: { s: PlayerSummary; rows: PlayedRow[] }) {
  const { record, backings } = s;
  return (
    <div className="pa-board">
      <GemasPanel rows={rows} />

      <section className="cut cut-card pa-panel pa-matches" aria-label="Matches">
        <Label>Matches</Label>
        {record.matches === 0 ? (
          <b className="pa-fig">None with a winner</b>
        ) : (
          <div className="pa-record">
            <WinRing value={record.wins / record.matches} />
            <dl className="pa-wl">
              <div>
                <dt>Won</dt>
                <dd>{record.wins}</dd>
              </div>
              <div>
                <dt>Lost</dt>
                <dd>{record.matches - record.wins}</dd>
              </div>
              <p>of {record.matches} with a winner</p>
            </dl>
          </div>
        )}
        {s.byGame.length > 0 && (
          <ul className="pa-bygame">
            {s.byGame.map((g) => (
              <li key={g.game}>
                <Image className="cut cut-btn" src={art.thumb[g.game]} alt="" width={40} height={40} />
                <span>
                  <b>{GAME_NAMES[g.game]}</b>
                  <i className="pa-meter" aria-hidden="true">
                    <i style={{ width: `${pct(g.wins, g.matches)}%` }} />
                  </i>
                </span>
                <span className="pa-gfig">
                  {g.wins}
                  <small>
                    <span className="sr-only"> won of </span>
                    <span aria-hidden="true">/</span>
                    {g.matches}
                  </small>
                </span>
              </li>
            ))}
          </ul>
        )}
        {(s.bestScore !== null || s.undecided > 0) && (
          <div className="pa-chips">
            {s.bestScore !== null && (
              <span className="cut cut-chip pa-chip">
                Best {GAME_NAMES["block-puzzle"]} score <b>{fmtGemas(s.bestScore)}</b>
              </span>
            )}
            {s.undecided > 0 && <span className="cut cut-chip pa-chip quiet">{s.undecided} draws and refunds, not counted</span>}
          </div>
        )}
      </section>

      <section className="cut cut-card pa-panel pa-backings" aria-label="Backings">
        <Label>Backings</Label>
        {backings.matches === 0 ? (
          <>
            <b className="pa-fig">None yet</b>
            <p className="pa-p">No Match with a winner was played under a Backing.</p>
          </>
        ) : (
          <>
            <div className="pa-bhead">
              <b className="pa-fig">
                {backings.wins} of {backings.matches} won
              </b>
              <span className="pa-ahead">
                <span aria-hidden="true">
                  {Array.from({ length: backings.backers }, (_, i) => (
                    <i key={i} className={i < backings.ahead ? "on" : undefined} />
                  ))}
                </span>
                {backings.ahead} of {backings.backers} {backings.backers === 1 ? "Backer" : "Backers"} ahead
              </span>
            </div>
            <BackersBalance won={backings.won} lost={backings.lost} />
            <dl className="pa-balance-figs">
              <div>
                <dt>Backers lost</dt>
                <dd className={backings.lost > 0 ? "lost" : undefined}>{signed(-backings.lost)}</dd>
              </div>
              <div className="net">
                <dt>Backers&apos; net</dt>
                <dd className={backings.net > 0 ? "won" : backings.net < 0 ? "lost" : undefined}>{signed(backings.net)}</dd>
              </div>
              <div>
                <dt>Backers won</dt>
                <dd className={backings.won > 0 ? "won" : undefined}>{signed(backings.won)}</dd>
              </div>
            </dl>
            <p className="note">A loss under a Backing costs the Player nothing, so read their Gemas beside their Backers&apos;.</p>
          </>
        )}
      </section>
    </div>
  );
}

/** The win rate as an octagon ring filled clockwise from the top, with the share inside. Neutral: a win rate is not Gemas. */
function WinRing({ value }: { value: number }) {
  const share = Math.min(1, Math.max(0, value));
  return (
    <div className="pa-ring">
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <path d={RING} className="track" pathLength={100} />
        <path d={RING} className="fill" pathLength={100} strokeDasharray={`${share * 100} 100`} />
      </svg>
      <span>
        <b>{Math.round(share * 100)}%</b>
        <small>won</small>
      </span>
    </div>
  );
}

// An octagon in a 100-unit box, 6 in from its edges, starting and ending at the top centre.
const RING = [[50, 6], [69, 6], [94, 31], [94, 69], [69, 94], [31, 94], [6, 69], [6, 31], [31, 6], [50, 6]]
  .map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`)
  .join(" ");

/** What the Backers lost (left, red) against what they won (right, emerald), both on one scale. */
function BackersBalance({ won, lost }: { won: number; lost: number }) {
  const max = Math.max(won, lost, 1);
  return (
    <div className="pa-balance" aria-hidden="true">
      <span className="lost">
        <i style={{ width: `${(lost / max) * 100}%` }} />
      </span>
      <span className="won">
        <i style={{ width: `${(won / max) * 100}%` }} />
      </span>
    </div>
  );
}

const SHOWN: [string, string][] = [
  ["Matches", "How many were won, of those with a winner."],
  ["Gemas won and lost", "After Fees, with a running total Match by Match."],
  ["Backings", "What the Backers made, beside the Player."],
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
              : "Get Gemas in your Wallet, then play a Match: your Account fills in as it settles. This is what other Players will see:"}
        </p>
      </div>
      {own &&
        hasGemas !== null &&
        (hasGemas ? (
          <Button variant="money" href="/play">
            Play now
          </Button>
        ) : (
          <Button variant="money" href="/wallet?open=1">
            Get Gemas
          </Button>
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

/** Game and entry for a Challenge, and the plain fact that the link is the only way it reaches the other Player. */
function ChallengeSheet({ open, onClose, player }: { open: boolean; onClose: () => void; player: string }) {
  const { auth } = useAccount();
  const router = useRouter();
  const [game, setGame] = useState<GameId>("block-puzzle");
  const [entry, setEntry] = useState<EntrySize>(1000);
  const [asset, setAsset] = useState<0 | 1 | 2>(0);
  return (
    <Sheet open={open} onClose={onClose} title={`Challenge ${player}`}>
      <div className="stack-lg">
        <fieldset className="entries pa-games">
          <legend className="sr-only">Game</legend>
          {GAME_LIST.map((g) => (
            <label key={g} className="entry">
              <input type="radio" name="pa-game" value={g} checked={game === g} onChange={() => setGame(g)} />
              <span className="cut cut-chip">{GAME_NAMES[g]}</span>
            </label>
          ))}
        </fieldset>
        {game === "trading-duel" && <AssetPicker value={asset} onChange={setAsset} name="pa-asset" />}
        <EntryPicker value={entry} onChange={setEntry} name="pa-entry" />
        <p className="pa-p">
          {BRAND.name} cannot tell this Player about your Challenge. You get a link to send them yourself, and whoever opens it first joins.{" "}
          {game === "block-puzzle" && "You play your run first, then get the link. "}
          Your entry goes in the Pot when you open it; if nobody joins, it is refunded.
        </p>
        <Button
          variant="money"
          block
          onClick={() => auth.gate("Challenge a Player", () => router.push(`/play/challenge?${gameQuery(game, asset)}entry=${entry}`))}
        >
          Open Challenge · {fmtGemas(entry)} Gemas
        </Button>
      </div>
    </Sheet>
  );
}

