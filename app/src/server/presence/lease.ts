/** A Queue Match counts as present while its opener touched it within this long. */
export const LEASE_FRESH_MS = 30_000;
/** How often an opener's page touches the lease. */
export const PRESENCE_EVERY_MS = 15_000;
export const MAX_IDS = 100;

export interface PresenceRow {
  match_key: string;
  seen_at: string;
}

/** The keys among `rows` seen less than `LEASE_FRESH_MS` before `now` (ms). */
export function freshKeys(rows: readonly PresenceRow[], now: number): string[] {
  return rows.filter((r) => now - Date.parse(r.seen_at) < LEASE_FRESH_MS && Date.parse(r.seen_at) <= now + LEASE_FRESH_MS).map((r) => r.match_key);
}

/** Parses `?ids=a,b,c`: distinct, non-empty, at most `MAX_IDS`, or null when it is absent or too long. */
export function parseIds(raw: string | null): string[] | null {
  if (!raw) return null;
  const ids = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  return ids.length === 0 || ids.length > MAX_IDS ? null : ids;
}

export interface PresenceStore {
  touch(matchKey: string, at: string): Promise<void>;
  rows(matchKeys: string[]): Promise<PresenceRow[]>;
}

export class MemoryPresenceStore implements PresenceStore {
  readonly map = new Map<string, string>();
  async touch(matchKey: string, at: string) {
    this.map.set(matchKey, at);
  }
  async rows(matchKeys: string[]) {
    return matchKeys.flatMap((k) => (this.map.has(k) ? [{ match_key: k, seen_at: this.map.get(k)! }] : []));
  }
}
