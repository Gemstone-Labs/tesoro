"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, Check, Copy, Swords, UserPlus } from "lucide-react";
import { PlayerAvatar, PlayerName, usePlayerLabel } from "@/components/account/Player";
import { Button, Card } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import { BRAND } from "@/lib/brand";
import { playerSummary } from "@/lib/chain/player-account";
import { usePlayerAccount } from "@/lib/chain/usePlayerAccount";
import { useFriends } from "@/lib/friends/FriendsProvider";
import { friendStatusText } from "@/lib/friends/words";
import { GAME_NAMES } from "@/lib/mock";
import "./friends.css";

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

/**
 * What someone sees after opening an add-me link (founder pick L1, calling card): the owner's face,
 * name and record, and Add friend. Signed out, Add friend signs in first and then finishes.
 */
export function FriendLinkCard({ code, owner }: { code: string; owner: string | null }) {
  if (!owner) {
    return (
      <Card large as="section" aria-label="Add-me link">
        <div className="stack">
          <h1 className="page-title">Add-me link</h1>
          <p className="meta">This link no longer works. Ask your friend for their new add-me link.</p>
          <Button href="/lobby">Go to the Lobby</Button>
        </div>
      </Card>
    );
  }
  return <Calling code={code} owner={owner} />;
}

function Calling({ code, owner }: { code: string; owner: string }) {
  const { auth } = useAccount();
  const friends = useFriends();
  const name = usePlayerLabel(owner);
  const { data } = usePlayerAccount(owner);
  const s = useMemo(() => (data ? playerSummary(data.played) : null), [data]);
  const relation = friends.relation(owner);
  const [pending, setPending] = useState(false);
  const sent = useRef(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const signedOut = auth.status === "signed-out";

  // Signing in comes back here: once the wallet exists, finish adding (once).
  const { act, status } = friends;
  useEffect(() => {
    if (!pending || sent.current || !auth.signer || status === "signed-out" || status === "loading") return;
    sent.current = true;
    act("redeem", { code }).then(
      (r) => {
        setNote(r.status === "friends" || r.status === "already-friends" || r.status === "own" ? null : friendStatusText(r.status ?? ""));
        setPending(false);
        sent.current = false;
      },
      (e) => {
        setNote(e instanceof Error ? e.message : String(e));
        setPending(false);
        sent.current = false;
      },
    );
  }, [pending, auth.signer, status, act, code]);

  const copy = () =>
    void navigator.clipboard?.writeText(window.location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });

  return (
    <section className="cut cut-frame fl-card" aria-labelledby="fl-name">
      <span className="cut fl-av">
        <PlayerAvatar account={owner} size={168} />
      </span>
      <h1 id="fl-name" className="page-title fl-name">
        <PlayerName account={owner} />
      </h1>
      <p className="fl-line">
        {relation === "self" ? "This is your add-me link." : relation === "friend" ? `You and ${name} are Friends.` : `${name} wants to be Friends on ${BRAND.name}.`}
      </p>
      {s && s.first !== null && (
        <dl className="fl-facts">
          <div>
            <dt>
              <CalendarDays aria-hidden="true" /> Playing since
            </dt>
            <dd>{day(s.first)}</dd>
          </div>
          <div>
            <dt>
              <Swords aria-hidden="true" /> Record
            </dt>
            <dd>{s.record.matches ? `${s.record.wins} of ${s.record.matches} won` : "No winner yet"}</dd>
          </div>
        </dl>
      )}
      {s && s.byGame.length > 0 && (
        <ul className="fl-games" aria-label="Plays">
          {s.byGame.map((g) => (
            <li key={g.game}>
              <span className="cut cut-chip fr-thumb">
                <Image src={art.thumb[g.game]} alt="" width={32} height={32} />
              </span>
              {GAME_NAMES[g.game]}
            </li>
          ))}
        </ul>
      )}
      <div className="fl-act">
        {relation === "self" ? (
          <Button block onClick={copy} icon={copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}>
            {copied ? "Copied" : "Copy your add-me link"}
          </Button>
        ) : relation === "friend" ? (
          <Button block href="/friends">
            Open Friends
          </Button>
        ) : (
          <Button block disabled={pending} icon={<UserPlus aria-hidden="true" />} onClick={() => (signedOut ? auth.gate("add a friend", () => setPending(true)) : setPending(true))}>
            {pending ? "Adding…" : "Add friend"}
          </Button>
        )}
        {signedOut && relation !== "self" && <small className="fl-small">You’ll sign in first. New here? You can sign up in a minute.</small>}
        {note && (
          <small className="fl-small" role="status">
            {note}
          </small>
        )}
      </div>
    </section>
  );
}
