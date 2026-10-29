"use client";

import Image from "next/image";
import { useState } from "react";
import { Check, Copy, Pencil, Swords } from "lucide-react";
import { PlayerAvatar, PlayerName, VerifiedMark } from "@/components/account/Player";
import { Button } from "@/components/ui";
import { AddFriendButton } from "@/components/friends/AddFriendButton";
import { FriendLinkButton } from "@/components/friends/FriendLinkButton";
import { AccountFacts } from "./AccountFacts";
import { art } from "@/lib/art";
import { ago } from "@/lib/catalogue";
import type { ChainRequest } from "@/lib/chain/backing";
import type { PlayerSummary } from "@/lib/chain/player-account";
import type { GameId } from "@/lib/mock";
import type { NameSuffix } from "@/lib/identity/display";
import { setEditProfileOpen } from "@/lib/identity/edit-profile";

interface Props {
  address: string;
  own: boolean;
  visitor: boolean;
  s: PlayerSummary;
  /** The games listed under the facts (`topGames`). */
  games: { game: GameId; matches: number; wins: number }[];
  now: number;
  /** Registry names the title does not already show. */
  otherNames: { suffix: NameSuffix; name: string }[];
  /** The Player's live Requests (the Backing tile shows the first). */
  requests: ChainRequest[];
  onChallenge: () => void;
}

/**
 * Who this Player is, as one tall card: the cave banner behind the avatar, name and key, three
 * facts (Playing since, Record, Backing), the Games, then the buttons: Edit profile and Friend link
 * on your own Account, Challenge and Add friend on anyone else's.
 */
export function AccountHero({ address, own, visitor, s, games, now, otherNames, requests, onChallenge }: Props) {
  const [copied, setCopied] = useState(false);
  const copyKey = () => {
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <header className="cut cut-frame pa-hero">
      <div className="pa-top">
        <Image className="pa-banner-img" src={art.profileBanner} alt="" fill sizes="(max-width: 1144px) 100vw, 1080px" priority />
        {s.latest !== null && (
          <span className={`pa-seen${now - s.latest < 60 * 60 * 1000 ? " fresh" : ""}`}>
            <i aria-hidden="true" />
            Played {ago(s.latest, now)}
          </span>
        )}
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
              <button type="button" className="cut cut-chip pa-key" title={address} onClick={copyKey}>
                <span className="mono">
                  {address.slice(0, 6)}…{address.slice(-4)}
                </span>
                {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                <span className="sr-only">Copy Account key {address}</span>
              </button>
              <span className="sr-only" role="status">
                {copied ? "Account key copied" : ""}
              </span>
            </div>
          </div>
        </div>
      </div>

      <AccountFacts s={s} games={games} now={now} visitor={visitor} requests={requests} />

      <div className="pa-actions">
        {own ? (
          <>
            <Button variant="light" onClick={() => setEditProfileOpen(true)} icon={<Pencil aria-hidden="true" />}>
              Edit profile
            </Button>
            <FriendLinkButton />
          </>
        ) : (
          <>
            {visitor && (
              <Button variant="light" onClick={onChallenge} icon={<Swords aria-hidden="true" />}>
                Challenge
              </Button>
            )}
            {visitor && <AddFriendButton account={address} />}
          </>
        )}
      </div>
    </header>
  );
}
