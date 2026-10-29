"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Check, Ellipsis, Minus, Swords, X } from "lucide-react";
import { PlayerAvatar, PlayerName, usePlayerLabel } from "@/components/account/Player";
import { InfoTip } from "@/components/money/Tip";
import { ChallengeSheet } from "@/components/match/ChallengeSheet";
import { Bust, Button, Card, Sheet } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import { ago } from "@/lib/catalogue";
import { accountHistory, unplayed } from "@/lib/chain/history";
import { playedRows } from "@/lib/chain/player-account";
import { usePlayerAccount } from "@/lib/chain/usePlayerAccount";
import { fmtGemas } from "@/lib/format";
import { useFriends } from "@/lib/friends/FriendsProvider";
import { readShape, writeShape } from "@/lib/friends/memory";
import { useFriendLink } from "@/lib/friends/useFriendLink";
import { recordAgainst, recordText, sortFriends, type FriendRecord } from "@/lib/friends/record";
import { GAME_SHORT, friendStatusText } from "@/lib/friends/words";
import { GAME_NAMES } from "@/lib/mock";
import { FriendLinkShare } from "./FriendLinkShare";
import "./friends.css";

const PAGE = 20;
const RESULT_WORD = { won: "Won", lost: "Lost", draw: "Draw" } as const;
const RESULT_ICON = { won: Check, lost: X, draw: Minus } as const;

/** The signed-in Player's private Friends page: requests, Challenges for them, their Friends and their Friend link. */
export function FriendsPage() {
  const { auth, snapshot } = useAccount();
  const friends = useFriends();
  const [now, setNow] = useState(() => Date.now());
  const [shown, setShown] = useState(PAGE);
  const view = friends.view;

  // "New" shows for this visit; leaving the page tells the server they have been seen.
  const hasNew = !!view?.friends.some((f) => f.isNew);
  const act = friends.act;
  useEffect(() => {
    if (!hasNew) return;
    return () => void act("seen").catch(() => undefined);
  }, [hasNew, act]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const friendAccounts = view?.friends.map((f) => f.account);
  const friendKey = friendAccounts?.join(",");
  useEffect(() => {
    if (friends.me && friendAccounts) writeShape(friends.me, {}, friendAccounts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [friends.me, friendKey]);

  const myRows = useMemo(() => (snapshot ? accountHistory(snapshot.matches) : []), [snapshot]);
  const records = useMemo(() => new Map((view?.friends ?? []).map((f) => [f.account, recordAgainst(myRows, f.account)])), [view, myRows]);
  const sorted = useMemo(() => sortFriends(view?.friends ?? [], records), [view, records]);

  if (friends.status === "signed-out") {
    return (
      <Card large as="section" aria-label="Sign in to see your Friends">
        <div className="stack">
          <h1 className="page-title">Friends</h1>
          <p className="meta">Your Friends list is private to your Account. Sign in to see it.</p>
          <Button block onClick={() => auth.openSignIn("see your Friends")}>Sign in</Button>
        </div>
      </Card>
    );
  }

  if (friends.status === "error" && !view) {
    return (
      <Card large as="section" aria-label="Friends">
        <div className="stack">
          <h1 className="page-title">Friends</h1>
          <p className="status err" role="alert">
            Your Friends couldn’t load. {friends.error}
          </p>
          <Button block onClick={() => void friends.unlock()}>Try again</Button>
        </div>
      </Card>
    );
  }

  if (!view) return <FriendsSkeleton />;

  return (
    <div className="fr-page">
      <header className="fr-head">
        <div>
          <h1 className="page-title">Friends</h1>
          <p className="fr-count">
            {view.friends.length} {view.friends.length === 1 ? "Friend" : "Friends"}
          </p>
        </div>
        <FriendLink />
      </header>

      {view.incoming.length > 0 && (
        <section className="cut cut-card fr-section" aria-labelledby="fr-req">
          <h2 id="fr-req" className="fr-h">Friend requests ({view.incoming.length})</h2>
          <ul className="fr-list">
            {view.incoming.map((r) => (
              <RequestRow key={r.account} account={r.account} />
            ))}
          </ul>
        </section>
      )}

      {view.challenges.length > 0 && (
        <section className="cut cut-card fr-section" aria-labelledby="fr-ch">
          <h2 id="fr-ch" className="fr-h">Challenges for you ({view.challenges.length})</h2>
          <ul className="fr-list">
            {view.challenges.map((c) => (
              <li key={c.matchId} className="fr-row fr-challenge">
                <Who account={c.from} sub="challenged you" />
                <span className="fr-game">
                  <span className="cut cut-chip fr-thumb">
                    <Image src={art.thumb[c.game]} alt="" width={32} height={32} />
                  </span>
                  <span>
                    <b>{GAME_NAMES[c.game]}</b>
                    <small>
                      {fmtGemas(c.entry)} Gemas · {ago(c.at, now)}
                    </small>
                  </span>
                </span>
                <span className="fr-actions">
                  <Button variant="light" href={`/play/challenge/${c.matchId}`}>Open</Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="fr-yours" aria-labelledby="fr-yours">
        <h2 id="fr-yours" className="fr-h-out">Your Friends ({sorted.length})</h2>
        {sorted.length === 0 ? (
          <div className="cut cut-card fr-section fr-empty">
            <Bust name="himWelcome" width={150} className="fr-empty-bust" />
            <div className="fr-empty-body">
              <b>No Friends yet</b>
              <p>Share your Friend link, or add Players from their Account page or after a Match. Friends can challenge each other in one tap and see each other’s latest Matches.</p>
            </div>
          </div>
        ) : (
          <>
            <ul className="fr-cards">
              {sorted.slice(0, shown).map((f) => (
                <FriendRow key={f.account} account={f.account} record={records.get(f.account)!} isNew={view.friends.find((x) => x.account === f.account)?.isNew ?? false} now={now} />
              ))}
            </ul>
            {sorted.length > shown && (
              <Button size="sm" onClick={() => setShown((n) => n + PAGE)}>
                Show more
              </Button>
            )}
          </>
        )}
      </section>
    </div>
  );
}

/** The page's shape while Friends load: the real link box and as many Friend cards as last time, each the real card's size. */
function FriendsSkeleton() {
  const { me } = useFriends();
  const [shape, setShape] = useState<boolean[]>([false]);
  useEffect(() => {
    const known = Object.values(readShape(me));
    if (known.length) setShape(known);
  }, [me]);
  return (
    <div className="fr-page" aria-busy="true">
      <span className="sr-only" role="status">
        Loading your Friends…
      </span>
      <header className="fr-head">
        <div>
          <h1 className="page-title">Friends</h1>
          <p className="fr-count" aria-hidden="true">
            {shape.length} {shape.length === 1 ? "Friend" : "Friends"}
          </p>
        </div>
        <FriendLink />
      </header>
      <section className="fr-yours" aria-hidden="true">
        <h2 className="fr-h-out">Your Friends ({shape.length})</h2>
        <ul className="fr-cards">
          {shape.map((chips, i) => (
            <li key={i} className="cut cut-card fr-card">
              <div className="fr-card-top">
                <span className="fr-who">
                  <span className="cut fr-av skel" />
                  <span className="fr-who-text skel-lines">
                    <span className="skel-line lg" style={{ width: 120 }} />
                    <span className="skel-line" style={{ width: 80 }} />
                  </span>
                </span>
                <span className="fr-card-act">
                  <span className="fr-played" />
                  <span className="cut cut-btn fr-btn-skel skel" />
                </span>
              </div>
              {chips && (
                <ul className="fr-chips">
                  {[0, 1, 2].map((j) => (
                    <li key={j} className="fr-chip-skel" />
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** Avatar and name, linking to the Account page. */
function Who({ account, sub, after, children }: { account: string; sub?: string; after?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <span className="fr-who">
      <Link href={`/account/${account}`} className="cut fr-av" aria-hidden="true" tabIndex={-1}>
        <PlayerAvatar account={account} size={56} wait />
      </Link>
      <span className="fr-who-text">
        <span className="fr-name-row">
          <Link href={`/account/${account}`} className="fr-name">
            <PlayerName account={account} wait />
          </Link>
          {after}
        </span>
        {sub && <small>{sub}</small>}
        {children}
      </span>
    </span>
  );
}

function RequestRow({ account }: { account: string }) {
  const friends = useFriends();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const run = async (op: "accept" | "decline") => {
    setBusy(true);
    try {
      const r = await friends.act(op, { from: account });
      setNote(friendStatusText(r.status ?? ""));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="fr-row">
      <Who account={account} sub="Wants to be Friends">
        {note && (
          <small className="fr-note" role="status">
            {note}
          </small>
        )}
      </Who>
      <span className="fr-actions">
        <Button variant="light" size="sm" disabled={busy} onClick={() => void run("accept")}>Accept</Button>
        <Button size="sm" disabled={busy} onClick={() => void run("decline")}>Decline</Button>
      </span>
    </li>
  );
}

function FriendRow({ account, record, isNew, now }: { account: string; record: FriendRecord; isNew: boolean; now: number }) {
  const { data } = usePlayerAccount(account);
  const last = useMemo(() => (data ? playedRows(data.played).filter((r) => !unplayed(r.result)).slice(0, 3) : null), [data]);
  const [challenge, setChallenge] = useState(false);
  const name = usePlayerLabel(account);
  const { me } = useFriends();
  const hasChips = last === null ? null : last.length > 0;
  useEffect(() => {
    if (me && hasChips !== null) writeShape(me, { [account]: hasChips });
  }, [me, account, hasChips]);
  return (
    <li className="cut cut-card fr-card">
      <div className="fr-card-top">
        <Who account={account} after={isNew ? <span className="cut cut-chip fr-tag">New</span> : null}>
          <span className="fr-rec">{recordText(record)}</span>
        </Who>
        <span className="fr-card-act">
          <span className="fr-played">
            {record.last !== null && <small>Played {ago(record.last, now)}</small>}
            <FriendMenu account={account} name={name} />
          </span>
          <Button variant="light" icon={<Swords aria-hidden="true" />} onClick={() => setChallenge(true)}>
            Challenge
          </Button>
        </span>
      </div>
      {(last === null || last.length > 0) && (
      <ul className="fr-chips" aria-label={`${name}'s latest Matches`}>
        {last === null
          ? [0, 1, 2].map((i) => <li key={i} className="fr-chip-skel" aria-hidden="true" />)
          : last.map((r) => {
              const Icon = RESULT_ICON[r.result as keyof typeof RESULT_ICON] ?? Minus;
              return (
                <li key={r.id} className="cut cut-chip fr-chip">
                  <Image src={art.thumb[r.game]} alt="" width={40} height={40} />
                  <span>
                    <b>{GAME_SHORT[r.game] ?? GAME_NAMES[r.game]}</b>
                    <small className={`fr-res ${r.result}`}>
                      <Icon aria-hidden="true" />
                      <span className="sr-only">{RESULT_WORD[r.result as keyof typeof RESULT_WORD]}, </span>
                      {ago(r.at, now).replace(" ago", "")}
                    </small>
                  </span>
                </li>
              );
            })}
      </ul>
      )}
      <ChallengeSheet open={challenge} onClose={() => setChallenge(false)} player={account} name={name} />
    </li>
  );
}

/** ⋯ on a Friend row: a small sheet (above every cut card, so nothing clips it) with View Account and Remove friend. */
function FriendMenu({ account, name }: { account: string; name: string }) {
  const friends = useFriends();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setOpen(false);
    setConfirm(false);
  };
  const remove = async () => {
    setBusy(true);
    try {
      await friends.act("remove", { account });
      close();
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="cut cut-btn btn fr-more" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Ellipsis aria-hidden="true" />
        <span className="sr-only">More for {name}</span>
      </button>
      <Sheet open={open} onClose={close} title={name}>
        <div className="stack">
          <Button block href={`/account/${account}`}>
            View Account
          </Button>
          {confirm ? (
            <>
              <Button block disabled={busy} onClick={() => void remove()}>
                {busy ? "Removing…" : `Remove ${name}`}
              </Button>
              <p className="meta fr-remove-note">They won’t get a notification, and you can add each other again anytime.</p>
            </>
          ) : (
            <Button block onClick={() => setConfirm(true)}>
              Remove friend
            </Button>
          )}
        </div>
      </Sheet>
    </>
  );
}

/** Your Friend link with adjacent Copy and Share actions, and Reset link as a setting. */
function FriendLink() {
  const { code, reset: resetLink } = useFriendLink();
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const closeReset = () => {
    setResetOpen(false);
    setResetError(null);
  };
  const reset = async () => {
    setResetting(true);
    setResetError(null);
    try {
      await resetLink();
      setResetOpen(false);
    } catch (e) {
      setResetError(e instanceof Error ? e.message : String(e));
    } finally {
      setResetting(false);
    }
  };
  return (
    <div className="cut cut-card fr-link">
      <div className="fr-link-top">
        <span className="fr-link-label">
          Your Friend link
          <InfoTip label="About your Friend link" align="start">
            Anyone with this link can add you as a Friend.
          </InfoTip>
        </span>
        <button type="button" className="fr-link-reset" disabled={!code} onClick={() => setResetOpen(true)}>
          Reset link
        </button>
      </div>
      <FriendLinkShare key={code ?? "loading"} code={code} disabled={resetting} />
      <Sheet open={resetOpen} onClose={closeReset} title="Reset your Friend link?">
        <div className="stack">
          <p className="meta fr-reset-text">
            You get a new link and the current one stops working: anyone who opens it sees that it no longer works. Your Friends stay your Friends. Do this if your link
            went somewhere you didn’t mean it to.
          </p>
          {resetError && (
            <p className="status err" role="alert">
              {resetError}
            </p>
          )}
          <div className="fr-reset-actions">
            <Button onClick={closeReset}>Cancel</Button>
            <Button variant="light" disabled={resetting} onClick={() => void reset()}>
              {resetting ? "Resetting…" : "Reset link"}
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
