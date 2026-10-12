"use client";

import Image from "next/image";
import { useState } from "react";
import { shownIdentity, type NameSuffix } from "@/lib/identity/display";
import { useIdentity } from "@/lib/identity/store";
import "./account.css";

/** The check next to a .sol / .eth / .hl name: the registry says this wallet owns it. */
export function VerifiedMark({ suffix }: { suffix: NameSuffix }) {
  return (
    <>
      <svg className="pn-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
        <path d="M5 1.5h6L14.5 5v6L11 14.5H5L1.5 11V5z" fill="currentColor" />
        <path d="M5 8.2l2 2L11 6" fill="none" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="square" />
      </svg>
      <span className="sr-only"> (verified {suffix} name)</span>
    </>
  );
}

/**
 * A Player's name: Profile name, else .sol, else .eth, else .hl, else the short key (`key` is the Account
 * key). One component everywhere a Player is shown, so every screen agrees.
 */
export function PlayerName({ account, className, wait }: { account: string; className?: string; wait?: boolean }) {
  const id = useIdentity(account);
  const shown = shownIdentity(account, id);
  if (wait && !id.settled) return <span className={`skel-line${className ? ` ${className}` : ""}`} style={{ width: "7em" }} aria-hidden="true" />;
  return (
    <span className={`pn${className ? ` ${className}` : ""}`} title={shown.named ? undefined : account}>
      <span className="pn-label">{shown.label}</span>
      {shown.verified && <VerifiedMark suffix={shown.verified} />}
    </span>
  );
}

/** The name as plain text, for labels and sentences that cannot hold markup. */
export function usePlayerLabel(account: string | null | undefined): string {
  const id = useIdentity(account);
  return account ? shownIdentity(account, id).label : "";
}

/**
 * A Player's picture: their pick, else the avatar derived from the key. A picture from a name record that fails to load falls back to the derived one.
 * `wait` shows a placeholder until the picture is known, instead of the derived one first.
 */
export function PlayerAvatar({ account, size, className, wait }: { account: string; size: number; className?: string; wait?: boolean }) {
  const id = useIdentity(account);
  const shown = shownIdentity(account, id);
  const [failed, setFailed] = useState<string | null>(null);
  if (wait && !id.settled) return <AvatarSkeleton />;
  if (shown.remoteAvatar && failed !== shown.avatar) {
    // Not served by us, so not through the image optimiser: loaded as is, without sending a referrer.
    // eslint-disable-next-line @next/next/no-img-element
    return <img className={className} src={shown.avatar} alt="" width={size} height={size} referrerPolicy="no-referrer" loading="lazy" onError={() => setFailed(shown.avatar)} />;
  }
  const local = shown.remoteAvatar ? shownIdentity(account).avatar : shown.avatar;
  return <Image className={className} src={local} alt="" width={size} height={size} />;
}

/** The shape of a picture still loading; fills its frame. */
export function AvatarSkeleton() {
  return <span className="skel skel-fill" aria-hidden="true" />;
}
