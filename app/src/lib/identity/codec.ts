import type { AvatarPick, ProfileData } from "./display";

/** `AvatarChoice` of tesoro_core as the Anchor client names its variants. */
export function avatarArg(pick: AvatarPick): Record<string, unknown> {
  if (pick.kind === "animal") return { animal: [pick.index] };
  return pick.kind === "name-service" ? { nameService: {} } : { default: {} };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function avatarFromChain(raw: any): AvatarPick {
  if (raw && typeof raw === "object") {
    if ("animal" in raw) {
      const v = raw.animal;
      const index = Number(Array.isArray(v) ? v[0] : (v?.["0"] ?? v));
      return Number.isInteger(index) && index >= 0 ? { kind: "animal", index } : { kind: "default" };
    }
    if ("nameService" in raw) return { kind: "name-service" };
  }
  return { kind: "default" };
}

/** A decoded `Profile` account as the app shows it; null for a malformed one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function profileFromChain(raw: any): ProfileData | null {
  if (!raw) return null;
  const len = Number(raw.nameLen);
  const bytes = Uint8Array.from(raw.name as ArrayLike<number>).slice(0, len);
  const name = new TextDecoder().decode(bytes).trim();
  return name ? { name, avatar: avatarFromChain(raw.avatar) } : null;
}

