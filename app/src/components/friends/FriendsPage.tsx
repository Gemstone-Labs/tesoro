"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Ellipsis, Swords } from "lucide-react";
import { PlayerAvatar, PlayerName, usePlayerLabel } from "@/components/account/Player";
import { ChallengeSheet } from "@/components/match/ChallengeSheet";
import { Button, Card, Sheet } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import { ago } from "@/lib/catalogue";
import { accountHistory } from "@/lib/chain/history";
import { playedRows } from "@/lib/chain/player-account";
import { usePlayerAccount } from "@/lib/chain/usePlayerAccount";
import { fmtGemas } from "@/lib/format";
import { useFriends } from "@/lib/friends/FriendsProvider";
import { recordAgainst, recordText, sortFriends, type FriendRecord } from "@/lib/friends/record";
import { friendStatusText } from "@/lib/friends/words";
import { GAME_NAMES } from "@/lib/mock";
import "./friends.css";

const PAGE = 20;
const RESULT_WORD = { won: "Won", lost: "Lost", draw: "Draw" } as const;

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

  const myRows = useMemo(() => (snapshot ? accountHistory(snapshot.matches) : []), [snapshot]);
  const records = useMemo(() => new Map((view?.friends ?? []).map((f) => [f.account, recordAgainst(myRows, f.account)])), [view, myRows]);
  const sorted = useMemo(() => sortFriends(view?.friends ?? [], records), [view, records]);

  if (auth.status === "signed-out" || friends.status === "signed-out") {
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

  if (friends.status === "locked" || (friends.status === "error" && !view)) {
    return (
      <Card large as="section" aria-label="Open your Friends">
        <div className="stack">
          <h1 className="page-title">Friends</h1>
          <p className="meta">Your Friends list is private: only you see it. Open it with one signature from your wallet. This browser remembers it for 30 days.</p>
          {friends.error && (
            <p className="status err" role="alert">
              {friends.error}
            </p>
          )}
          <Button block onClick={() => void friends.unlock()}>Open Friends</Button>
        </div>
      </Card>
    );
  }

  if (!view) {
    return (
      <div className="fr-page" aria-busy="true">
        <header className="fr-head">
          <h1 className="page-title">Friends</h1>
        </header>
        <div className="cut cut-card fr-section fr-skel" aria-label="Loading your Friends…" />
      </div>
    );
  }

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
                  <Button href={`/play/challenge/${c.matchId}`}>Open</Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="cut cut-card fr-section" aria-labelledby="fr-yours">
        <h2 id="fr-yours" className="fr-h">Your friends</h2>
        {sorted.length === 0 ? (
          <p className="fr-empty">No Friends yet. Share your Friend link, or add Players from their Account page or after a Match.</p>
        ) : (
          <>
            <ul className="fr-list">
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

/** Avatar and name, linking to the Account page. */
function Who({ account, sub, children }: { account: string; sub?: string; children?: React.ReactNode }) {
  return (
    <span className="fr-who">
      <Link href={`/account/${account}`} className="cut fr-av" aria-hidden="true" tabIndex={-1}>
        <PlayerAvatar account={account} size={56} />
      </Link>
      <span className="fr-who-text">
        <Link href={`/account/${account}`} className="fr-name">
          <PlayerName account={account} />
        </Link>
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
        <Button disabled={busy} onClick={() => void run("accept")}>Accept</Button>
        <Button disabled={busy} onClick={() => void run("decline")}>Decline</Button>
      </span>
    </li>
  );
}

function FriendRow({ account, record, isNew, now }: { account: string; record: FriendRecord; isNew: boolean; now: number }) {
  const { data } = usePlayerAccount(account);
  const last = useMemo(() => (data ? playedRows(data.played).filter((r) => r.result !== "refunded").slice(0, 3) : null), [data]);
  const [challenge, setChallenge] = useState(false);
  const name = usePlayerLabel(account);
  return (
    <li className="fr-row fr-friend">
      <Who account={account}>
        <span className="fr-rec">
          {recordText(record)}
          {isNew && <span className="cut cut-chip fr-tag">New</span>}
          {record.last !== null && <span className="cut cut-chip fr-tag">Played {ago(record.last, now)}</span>}
        </span>
      </Who>
      <ul className="fr-recent" aria-label={`${name}'s latest Matches`}>
        {last === null
          ? [0, 1, 2].map((i) => <li key={i} className="fr-recent-skel" aria-hidden="true" />)
          : last.map((r) => (
              <li key={r.id}>
                <span className="cut cut-chip fr-thumb">
                  <Image src={art.thumb[r.game]} alt="" width={32} height={32} />
                </span>
                <span>
                  <b className={`fr-res ${r.result}`}>{RESULT_WORD[r.result as keyof typeof RESULT_WORD]}</b> {GAME_NAMES[r.game]}
                  <small>{ago(r.at, now)}</small>
                </span>
              </li>
            ))}
      </ul>
      <span className="fr-actions">
        <Button icon={<Swords aria-hidden="true" />} onClick={() => setChallenge(true)}>
          Challenge
        </Button>
        <FriendMenu account={account} name={name} />
      </span>
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
              <p className="meta">{name} won’t be told. You can add each other again later.</p>
              <Button block disabled={busy} onClick={() => void remove()}>
                {busy ? "Removing…" : `Remove ${name}`}
              </Button>
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

/** Your Friend link with Copy and Reset link. */
function FriendLink() {
  const friends = useFriends();
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    let stopped = false;
    void friends.act("link").then(
      (r) => !stopped && setCode(r.code ?? null),
      () => undefined,
    );
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const url = code ? `${typeof window === "undefined" ? "" : window.location.host}/friend/${code}` : "";
  const copy = () =>
    void navigator.clipboard?.writeText(`${window.location.origin}/friend/${code}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  const reset = async () => {
    const r = await friends.act("reset-link");
    setCode(r.code ?? null);
    setConfirmReset(false);
  };
  return (
    <div className="cut cut-card fr-link">
      <span className="fr-link-label">Your Friend link</span>
      <div className="fr-link-row">
        <span className="cut cut-chip fr-link-url mono">{url || "…"}</span>
        <Button size="sm" disabled={!code} onClick={copy} icon={copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}>
          {copied ? "Copied" : "Copy"}
        </Button>
        {confirmReset ? (
          <Button size="sm" onClick={() => void reset()}>
            Reset? The old link stops working
          </Button>
        ) : (
          <Button size="sm" disabled={!code} onClick={() => setConfirmReset(true)}>
            Reset link
          </Button>
        )}
      </div>
      <small className="fr-link-help">Anyone with this link can add you as a friend.</small>
      <span className="sr-only" role="status">
        {copied ? "Friend link copied" : ""}
      </span>
    </div>
  );
}
