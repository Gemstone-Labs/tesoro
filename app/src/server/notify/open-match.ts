import type { GameId } from "@/lib/mock/types";
import type { Rpc } from "../history/rpc";

/** A Player of a Match: the TesoroAccount key and the wallet that controls it (the key notification settings are kept under). */
export interface MatchPlayer {
  account: string;
  authority: string;
}

/** A Match that is open or being played, as the webhook saw it. */
export interface OpenMatch {
  /** The Match account's address. */
  matchState: string;
  /** `<opener Account>-<n>`, the id the app shows. */
  matchKey: string;
  game: GameId;
  entry: number;
  /** Opener first. */
  players: MatchPlayer[];
  /** tesoro_core's refund deadline, unix seconds; null until a second Player joins. */
  deadline: number | null;
}

/** Open Matches with their refund deadlines, filled from the transactions the webhook delivers. Every write is idempotent. */
export interface OpenMatchStore {
  open(m: Omit<OpenMatch, "players" | "deadline"> & { opener: MatchPlayer }): Promise<void>;
  /** Adds the joiner and sets the deadline (the first join wins). Nothing happens for a Match the store does not know. */
  join(matchState: string, joiner: MatchPlayer, deadline: number): Promise<void>;
  extend(matchState: string, deadline: number): Promise<void>;
  get(matchState: string): Promise<OpenMatch | null>;
  /** The Match has settled or been refunded. It stays readable for a few days (its emails may still be retried). */
  close(matchState: string): Promise<void>;
  /** Joined Matches that are not closed and whose Delayed email was not sent. */
  toCheck(): Promise<OpenMatch[]>;
  delayedTold(matchState: string): Promise<void>;
  /** Drops what is no longer needed; returns how many rows went. */
  prune(nowSecs: number): Promise<number>;
}

/** In memory, for tests. */
export class MemoryOpenMatchStore implements OpenMatchStore {
  readonly rows = new Map<string, OpenMatch & { closed: boolean; told: boolean }>();
  async open({ opener, ...m }: Parameters<OpenMatchStore["open"]>[0]) {
    if (!this.rows.has(m.matchState)) this.rows.set(m.matchState, { ...m, players: [opener], deadline: null, closed: false, told: false });
  }
  async join(matchState: string, joiner: MatchPlayer, deadline: number) {
    const r = this.rows.get(matchState);
    if (!r || r.closed) return;
    if (!r.players.some((p) => p.account === joiner.account)) r.players.push(joiner);
    r.deadline ??= deadline;
  }
  async extend(matchState: string, deadline: number) {
    const r = this.rows.get(matchState);
    if (r && !r.closed) r.deadline = deadline;
  }
  async get(matchState: string) {
    const r = this.rows.get(matchState);
    return r ? { matchState: r.matchState, matchKey: r.matchKey, game: r.game, entry: r.entry, players: r.players.map((p) => ({ ...p })), deadline: r.deadline } : null;
  }
  async close(matchState: string) {
    const r = this.rows.get(matchState);
    if (r) r.closed = true;
  }
  async toCheck() {
    return Promise.all([...this.rows.values()].filter((r) => !r.closed && r.deadline !== null && !r.told).map((r) => this.get(r.matchState) as Promise<OpenMatch>));
  }
  async delayedTold(matchState: string) {
    const r = this.rows.get(matchState);
    if (r) r.told = true;
  }
  async prune() {
    return 0;
  }
}

type Row = { match_state: string; match_key: string; game: GameId; entry: number | string; players: MatchPlayer[]; deadline: number | string | null };
const fromRow = (r: Row): OpenMatch => ({ matchState: r.match_state, matchKey: r.match_key, game: r.game, entry: Number(r.entry), players: r.players, deadline: r.deadline === null ? null : Number(r.deadline) });

/** The functions of migration 0022 over `rpc`. */
export const rpcOpenMatchStore = (rpc: Rpc): OpenMatchStore => ({
  open: async ({ opener, ...m }) => void (await rpc("open_match_open", { p: { matchState: m.matchState, matchKey: m.matchKey, game: m.game, entry: m.entry, opener } })),
  join: async (matchState, joiner, deadline) => void (await rpc("open_match_join", { p: { matchState, joiner, deadline } })),
  extend: async (matchState, deadline) => void (await rpc("open_match_extend", { p_match_state: matchState, p_deadline: deadline })),
  get: async (matchState) => {
    const r = (await rpc("open_match_get", { p_match_state: matchState })) as Row | null;
    return r ? fromRow(r) : null;
  },
  close: async (matchState) => void (await rpc("open_match_close", { p_match_state: matchState })),
  toCheck: async () => ((await rpc("open_match_to_check", {})) as Row[]).map(fromRow),
  delayedTold: async (matchState) => void (await rpc("open_match_delayed_told", { p_match_state: matchState })),
  prune: async (nowSecs) => Number(await rpc("open_match_prune", { p_now: nowSecs, p_closed_days: 3, p_stale_days: 7 })),
});
