import type { GameId } from "./mock/types";

/** A key per Game: adding a Game id to `GameId` fails type checking here until it is listed. */
const KNOWN = { "block-puzzle": true, holdem: true, "trading-duel": true, vanguard: true } satisfies Record<GameId, true>;

/** Every Game, in the order the app lists them. */
export const GAME_LIST = Object.keys(KNOWN) as GameId[];

export const isGameId = (v: unknown): v is GameId => typeof v === "string" && Object.hasOwn(KNOWN, v);
