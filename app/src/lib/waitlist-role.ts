/** Who a waitlist member says they are. Optional, several allowed; the picks print on their card. */
export const ROLES = [
  { key: "player", tag: "Player", chip: "I play games" },
  { key: "staker", tag: "Staker", chip: "I stake crypto" },
  { key: "studio", tag: "Studio", chip: "I make games" },
] as const;

export type Role = (typeof ROLES)[number]["key"];

const KEYS = new Set<string>(ROLES.map((r) => r.key));

/** Roles from a comma list, in ROLES order, unknown words dropped. */
export function parseRoles(raw: unknown): Role[] {
  if (typeof raw !== "string") return [];
  const picked = new Set(raw.split(",").map((s) => s.trim()));
  return ROLES.map((r) => r.key).filter((k) => picked.has(k) && KEYS.has(k));
}

export const roleTags = (roles: readonly Role[]) => ROLES.filter((r) => roles.includes(r.key)).map((r) => r.tag);
