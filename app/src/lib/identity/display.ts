import { art, avatarFor } from "@/lib/art";
import { shortKey } from "@/lib/chain/history";

/** What a Player picked on chain (`AvatarChoice` of tesoro_core). */
export type AvatarPick = { kind: "default" } | { kind: "name-service" } | { kind: "animal"; index: number };

export interface ProfileData {
  name: string;
  avatar: AvatarPick;
}

export interface NameRecord {
  name: string;
  avatar: string | null;
}

/** Everything known about how a Player is shown; any part may be missing. */
export interface Identity {
  profile: ProfileData | null;
  sol: NameRecord | null;
  eth: NameRecord | null;
  /** The wallets the Player attached to their Profile for names (addresses); null when none. */
  attached?: { wallet: string | null; evm: string | null };
}

export interface Shown {
  /** The name to display: Profile name, else .sol, else .eth, else the short key. */
  label: string;
  /** Set when the label is a .sol or .eth name, which carries the verified mark. */
  verified: ".sol" | ".eth" | null;
  /** True when the Player chose the label (a Profile name or a name-service name), not a key. */
  named: boolean;
  /** A local avatar path, or an https URL from the Player's .sol / .eth record. */
  avatar: string;
  /** The avatar is a remote image from a name record: not served by us, may fail to load. */
  remoteAvatar: boolean;
}

export const EMPTY_IDENTITY: Identity = { profile: null, sol: null, eth: null };

export const PROFILE_NAME_MIN = 3;
export const PROFILE_NAME_MAX = 20;
const NAME_CHARS = /^[A-Za-z0-9 ._-]+$/;

/** The rule `set_profile` enforces: 3 to 20 letters, digits, spaces, dots, underscores or dashes, trimmed. */
export function profileNameError(raw: string): string | null {
  const name = raw.trim();
  if (name.length < PROFILE_NAME_MIN) return `Use at least ${PROFILE_NAME_MIN} characters.`;
  if (name.length > PROFILE_NAME_MAX) return `Use at most ${PROFILE_NAME_MAX} characters.`;
  if (!NAME_CHARS.test(name)) return "Use letters, numbers, spaces, dots, dashes and underscores.";
  return null;
}

export function animalAvatar(index: number): string {
  return art.avatars[index] ?? art.avatars[0];
}

/** The name-service picture, .sol first, as the name priority does. */
export function nameServiceAvatar(id: Identity): string | null {
  return id.sol?.avatar ?? id.eth?.avatar ?? null;
}

/** Applies the display rules to one Player (`key` is the Account key). */
export function shownIdentity(key: string, id: Identity = EMPTY_IDENTITY): Shown {
  let label = shortKey(key);
  let verified: Shown["verified"] = null;
  let named = false;
  if (id.profile) {
    label = id.profile.name;
    named = true;
  } else if (id.sol) {
    label = id.sol.name;
    verified = ".sol";
    named = true;
  } else if (id.eth) {
    label = id.eth.name;
    verified = ".eth";
    named = true;
  }

  let avatar = avatarFor(key);
  let remoteAvatar = false;
  const pick = id.profile?.avatar;
  if (pick?.kind === "animal") avatar = animalAvatar(pick.index);
  else if (pick?.kind === "name-service") {
    const remote = nameServiceAvatar(id);
    if (remote) {
      avatar = remote;
      remoteAvatar = true;
    }
  }
  return { label, verified, named, avatar, remoteAvatar };
}
