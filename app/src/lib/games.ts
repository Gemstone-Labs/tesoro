import type { GameId } from "./mock/types";

/** A key per Game: adding a Game id to `GameId` fails type checking here until it is listed. */
const KNOWN = { "block-puzzle": true, holdem: true, "trading-duel": true, vanguard: true } satisfies Record<GameId, true>;

const known = (v: unknown): v is GameId => typeof v === "string" && Object.hasOwn(KNOWN, v);

/** Game ids named in a comma-separated list; unknown names are ignored. */
export const parseHiddenGames = (raw: string | undefined): ReadonlySet<GameId> =>
  new Set((raw ?? "").split(",").map((s) => s.trim()).filter(known));

/**
 * The one switch that keeps a Game off an environment: NEXT_PUBLIC_HIDDEN_GAMES=vanguard on Vercel Production.
 * Unset (staging, local) hides nothing. Next inlines NEXT_PUBLIC_ variables only when written out in full.
 */
export const HIDDEN_GAMES = parseHiddenGames(process.env.NEXT_PUBLIC_HIDDEN_GAMES);

export const isHiddenGame = (g: GameId): boolean => HIDDEN_GAMES.has(g);

/** Every Game shown here, in the order the app lists them. */
export const GAME_LIST = (Object.keys(KNOWN) as GameId[]).filter((g) => !HIDDEN_GAMES.has(g));

/** A Game id that exists and is not hidden here. A hidden Game reads as unknown everywhere (404, falls back, refused). */
export const isGameId = (v: unknown): v is GameId => known(v) && !HIDDEN_GAMES.has(v);
