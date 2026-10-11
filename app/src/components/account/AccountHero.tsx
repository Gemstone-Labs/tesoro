"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { CalendarDays, Check, Copy, Link2, Pencil, Swords } from "lucide-react";
import { PlayerAvatar, PlayerName, VerifiedMark } from "@/components/account/Player";
import { Button } from "@/components/ui";
import { art } from "@/lib/art";
import { ago } from "@/lib/catalogue";
import type { PlayerSummary } from "@/lib/chain/player-account";
import type { NameSuffix } from "@/lib/identity/display";
import { setEditProfileOpen } from "@/lib/identity/edit-profile";
import { GAME_NAMES } from "@/lib/mock";

const day = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });

interface Props {
  address: string;
  own: boolean;
  visitor: boolean;
  s: PlayerSummary;
  now: number;
  /** Registry names the title does not already show. */
  otherNames: { suffix: NameSuffix; name: string }[];
  /** Live Requests; the strip under the hero lists them. */
  asking: number;
  onChallenge: () => void;
}

/**
 * Who this Player is: the profile banner (the default Tesoro banner until Players can pick their
 * own), the avatar over its edge with the name, the key as a chip that copies itself, then the
 * facts with their labels. Challenge is the one action a visitor came for.
 */
export function AccountHero({ address, own, visitor, s, now, otherNames, asking, onChallenge }: Props) {
  const [copied, setCopied] = useState<"link" | "key" | null>(null);
  const copy = (what: "link" | "key") => {
    const text = what === "key" ? address : `${window.location.origin}/account/${address}`;
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    });
  };

  return (
    <header className="cut cut-frame pa-hero">
      <div className="pa-banner">
        <Image src={art.profileBanner} alt="" fill sizes="(max-width: 1144px) 100vw, 1080px" priority />
        {s.latest !== null && (
          <span className={`pa-seen${now - s.latest < 60 * 60 * 1000 ? " fresh" : ""}`}>
            <i aria-hidden="true" />
            Played {ago(s.latest, now)}
          </span>
        )}
      </div>

      <div className="pa-id">
        <span className="cut cut-btn avatar pa-avatar">
          <PlayerAvatar account={address} size={140} />
        </span>
        <div className="pa-who">
          <h1 className="page-title">
            <PlayerName account={address} />
          </h1>
          <div className="pa-sub">
            {otherNames.map((n) => (
              <span key={n.suffix} className="pn pa-name">
                <span className="pn-label">{n.name}</span>
                <VerifiedMark suffix={n.suffix} />
              </span>
            ))}
            <button type="button" className="cut cut-chip pa-key" title={address} onClick={() => copy("key")}>
              <span className="mono">
                {address.slice(0, 6)}…{address.slice(-6)}
              </span>
              {copied === "key" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              <span className="sr-only">Copy Account key {address}</span>
            </button>
            {own && <span className="pa-own">How other Players see you</span>}
          </div>
        </div>
        <div className="pa-hero-actions">
          {visitor && (
            <Button onClick={onChallenge} icon={<Swords aria-hidden="true" />}>
              Challenge
            </Button>
          )}
          {own && (
            <Button onClick={() => setEditProfileOpen(true)} icon={<Pencil aria-hidden="true" />}>
              Edit profile
            </Button>
          )}
          <button type="button" className="cut cut-btn btn pa-icon" title="Copy link to this Account" onClick={() => copy("link")}>
            {copied === "link" ? <Check aria-hidden="true" /> : <Link2 aria-hidden="true" />}
            <span className="sr-only">Copy link to this Account</span>
          </button>
          <span className="sr-only" role="status">
            {copied === "link" ? "Link copied" : copied === "key" ? "Account key copied" : ""}
          </span>
        </div>
      </div>

      {(s.first !== null || visitor) && (
        <dl className="pa-facts">
          {s.first !== null && (
            <>
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
            </>
          )}
          {s.byGame.length > 0 && (
            <div>
              <dt>Plays</dt>
              <dd>
                {s.byGame.map((g) => (
                  <span key={g.game} className="pa-game">
                    <span className="cut cut-chip pa-thumb">
                      <Image src={art.thumb[g.game]} alt="" width={28} height={28} />
                    </span>
                    {GAME_NAMES[g.game]}
                  </span>
                ))}
              </dd>
            </div>
          )}
          {visitor && (
            <div>
              <dt>Backing</dt>
              <dd>
                {asking > 0 ? (
                  <a href="#pa-asks">Asking to be backed</a>
                ) : (
                  <span className="pa-quiet">
                    Not asking now · <Link href="/backing">See open Requests</Link>
                  </span>
                )}
              </dd>
            </div>
          )}
        </dl>
      )}
    </header>
  );
}
