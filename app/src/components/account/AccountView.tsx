"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Link2 } from "lucide-react";
import { GameTabs, HistoryPages, gameFilter } from "@/components/match/MatchHistory";
import { MatchRow } from "@/components/match/MatchRow";
import { Button, Card, EntryPicker, GemaMark, Label, Sheet, SkeletonCards } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { avatarFor } from "@/lib/art";
import { accountKeyOf, parseAccountKey } from "@/lib/chain/account-key";
import { historyPage, shortKey } from "@/lib/chain/history";
import { backingLine, playedRows, playerSummary, runningTotal, signed, type PlayerAccount, type PlayerSummary } from "@/lib/chain/player-account";
import { timeLeft } from "@/lib/chain/useBackingBoard";
import { usePlayerAccount } from "@/lib/chain/usePlayerAccount";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import type { EntrySize, GameId } from "@/lib/mock";
import { RunningTotalChart } from "./RunningTotalChart";
import "./account.css";

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
          <p>This Account could not be read from Solana devnet.</p>
          <Button size="sm" onClick={refresh}>Try again</Button>
        </div>
      </div>
    ) : (
      <div className="pa">
        <h1 className="page-title">Account</h1>
        <div className="mh-list">
          <SkeletonCards count={4} avatar={false} className="mh-skel" label="Reading this Account from Solana devnet…" />
        </div>
      </div>
    );
  }
  if (!data.exists) return <Notice title="Account not found" body="There is no Tesoro Account at this address on Solana devnet." />;
  return <Loaded address={key} data={data} stale={!!error} />;
}

function Loaded({ address, data, stale }: { address: string; data: PlayerAccount; stale: boolean }) {
  const { auth, snapshot } = useAccount();
  const params = useSearchParams();
  const [now] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [challenge, setChallenge] = useState(false);

  const rows = useMemo(() => playedRows(data.played), [data.played]);
  const summary = useMemo(() => playerSummary(data.played), [data.played]);
  const series = useMemo(() => runningTotal(rows), [rows]);
  const game = gameFilter(params.get("game"));
  const shown = game ? rows.filter((r) => r.game === game) : rows;
  const view = historyPage(shown, Number(params.get("page") ?? 1));
  const base = `/account/${address}`;

  const me = snapshot?.accountKey.toBase58() ?? (auth.addresses.solana ? accountKeyOf(auth.addresses.solana) : null);
  const own = me === address;
  const name = shortKey(address);

  const copy = () => {
    void navigator.clipboard?.writeText(`${window.location.origin}${base}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="pa">
      <header className="pa-head">
        <span className="cut cut-btn avatar pa-avatar">
          <Image src={avatarFor(address)} alt="" width={96} height={96} priority />
        </span>
        <div className="pa-who">
          <Label>{own ? "Your Account" : "Account"}</Label>
          <h1 className="page-title">{name}</h1>
          <span className="mono pa-key">{address}</span>
        </div>
        <Button size="sm" onClick={copy} icon={copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}>
          {copied ? "Link copied" : "Copy link"}
        </Button>
        <span className="sr-only" role="status">
          {copied ? "Link copied" : ""}
        </span>
      </header>

      {own && (
        <p className="pa-own">
          This is your Account as other Players see it. Your Gemas and Positions stay in your <Link href="/wallet">Wallet</Link>; Matches you backed are in{" "}
          <Link href="/matches">All Matches</Link>.
        </p>
      )}

      {rows.length === 0 && summary.notRead === 0 ? (
        <p className="pa-none">No finished Matches yet. They appear here as they settle on Solana devnet.</p>
      ) : (
        <Figures s={summary} />
      )}

      {series.length >= 2 && (
        <Card as="section" className="pa-card" aria-label="Running total of Gemas won and lost">
          <RunningTotalChart series={series} />
        </Card>
      )}

      {!own && auth.status !== "loading" && (
        <div className="pa-actions">
          <Card as="section" className="pa-card" aria-labelledby="pa-back">
            <h2 id="pa-back" className="pa-h">Back this Player</h2>
            {data.requests.length === 0 ? (
              <>
                <p className="pa-p">Not asking to be backed right now. A Backing answers a Request, so there is nothing to make an Offer on yet.</p>
                <Link href="/backing" className="pa-more">See open Requests</Link>
              </>
            ) : (
              <>
                <p className="pa-p">{name} is asking to be backed. You fund the whole entry and choose the share of the surplus you offer.</p>
                <ul className="pa-reqs">
                  {data.requests.map((r) => (
                    <li key={r.address.toBase58()}>
                      <span>
                        <b>{GAME_NAMES[r.game]}</b>
                        <small>
                          Entry {fmtGemas(r.entry)} Gemas · {timeLeft(r.expiresAt, now)}
                        </small>
                      </span>
                      <Button variant="money" size="sm" href={`/backing#${r.address.toBase58()}`}>
                        Make an Offer
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>
          <Card as="section" className="pa-card" aria-labelledby="pa-challenge">
            <h2 id="pa-challenge" className="pa-h">Challenge this Player</h2>
            <p className="pa-p">Open a Match outside the Queue and send {name} the link. Tesoro does not tell them: the link is how they find it.</p>
            <Button onClick={() => setChallenge(true)}>
              Challenge <Link2 aria-hidden="true" />
            </Button>
          </Card>
        </div>
      )}

      <section className="pa-history" aria-labelledby="pa-matches">
        <header className="mh-head">
          <h2 id="pa-matches" className="h-section">Match history</h2>
          {rows.length > 0 && <GameTabs base={base} game={game} />}
        </header>
        {shown.length === 0 ? (
          rows.length > 0 && <p className="pa-none">No finished {game ? GAME_NAMES[game] : ""} Matches yet.</p>
        ) : (
          <>
            <div className="mh-list" role="list" aria-label={`${game ? GAME_NAMES[game] : "All"} Matches, page ${view.page} of ${view.pages}`}>
              {view.rows.map((r) => (
                <div key={r.id} role="listitem">
                  <MatchRow r={r} now={now} showGame={!game} link="opponent" backing={backingLine(r)} />
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
        {stale && <p className="note">Could not refresh from Solana devnet; showing the last read.</p>}
      </section>

      <p className="note">Solana devnet · testnet Gemas from a simulated Position.</p>

      <ChallengeSheet open={challenge} onClose={() => setChallenge(false)} player={name} />
    </div>
  );
}

const pct = (wins: number, of: number) => Math.round((wins / of) * 100);
const plural = (n: number, one: string, many: string) => `${fmtGemas(n)} ${n === 1 ? one : many}`;

/** The three figures. Every rate carries its sample size, and the Player's Gemas sit beside their Backers'. */
function Figures({ s }: { s: PlayerSummary }) {
  const { record, backings } = s;
  return (
    <div className="pa-figs">
      <Card as="section" className="pa-fig" aria-label="Matches">
        <Label>Matches</Label>
        {record.matches === 0 ? (
          <b>None with a winner</b>
        ) : (
          <b>
            {record.wins} of {record.matches} won
          </b>
        )}
        <p>
          {record.matches > 0 && `${pct(record.wins, record.matches)}% of ${plural(record.matches, "Match", "Matches")} with a winner. `}
          {s.undecided > 0 && `${plural(s.undecided, "draw or refund", "draws or refunds")} not counted.`}
        </p>
      </Card>
      <Card as="section" className="pa-fig" aria-label="Gemas won and lost">
        <Label>Gemas won and lost</Label>
        <b>
          <GemaMark size={26} />
          {signed(s.net)}
        </b>
        <p>
          {signed(s.won)} won · {signed(-s.lost)} lost, after Fees.
          {backings.matches > 0 && " A loss under a Backing costs the Player nothing: see Backings."}
        </p>
      </Card>
      <Card as="section" className="pa-fig" aria-label="Backings">
        <Label>Backings</Label>
        {backings.matches === 0 ? (
          <>
            <b>None yet</b>
            <p>No Match with a winner was played under a Backing.</p>
          </>
        ) : (
          <>
            <b>
              {backings.wins} of {backings.matches} won
            </b>
            <p>
              Backers: {signed(backings.won)} won · {signed(-backings.lost)} lost · net {signed(backings.net)} Gemas. {backings.ahead} of{" "}
              {plural(backings.backers, "Backer", "Backers")} ahead.
            </p>
          </>
        )}
      </Card>
    </div>
  );
}

const GAMES: GameId[] = ["block-puzzle", "holdem"];

/** Game and entry for a Challenge, and the plain fact that the link is the only way it reaches the other Player. */
function ChallengeSheet({ open, onClose, player }: { open: boolean; onClose: () => void; player: string }) {
  const { auth } = useAccount();
  const router = useRouter();
  const [game, setGame] = useState<GameId>("block-puzzle");
  const [entry, setEntry] = useState<EntrySize>(1000);
  return (
    <Sheet open={open} onClose={onClose} title={`Challenge ${player}`}>
      <div className="stack-lg">
        <fieldset className="entries pa-games">
          <legend className="sr-only">Game</legend>
          {GAMES.map((g) => (
            <label key={g} className="entry">
              <input type="radio" name="pa-game" value={g} checked={game === g} onChange={() => setGame(g)} />
              <span className="cut cut-chip">{GAME_NAMES[g]}</span>
            </label>
          ))}
        </fieldset>
        <EntryPicker value={entry} onChange={setEntry} name="pa-entry" />
        <p className="pa-p">
          Tesoro cannot tell this Player about your Challenge. You get a link to send them yourself, and whoever opens it first joins.{" "}
          {game === "block-puzzle" && "You play your run first, then get the link. "}
          Your entry goes in the Pot when you open it; if nobody joins, it is refunded.
        </p>
        <Button
          variant="money"
          block
          onClick={() => auth.gate("Challenge a Player", () => router.push(`/play/challenge?${game === "holdem" ? "game=holdem&" : ""}entry=${entry}`))}
        >
          Open Challenge · {fmtGemas(entry)} Gemas
        </Button>
      </div>
    </Sheet>
  );
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <Card large as="section">
      <div className="stack">
        <h1 className="page-title">{title}</h1>
        <p className="meta">{body}</p>
        <Button href="/">Lobby</Button>
      </div>
    </Card>
  );
}
