import type { PublicKey } from "@solana/web3.js";
import { ENTRY_GEMAS, RAILCAR_PROGRAM_ID } from "@/games/railcar/chain";
import { art } from "@/lib/art";
import { GAME_IDS } from "@/lib/chain/games";
import { gameOf } from "@/lib/chain/read";
import { GAME_LIST, RAILCAR_SHOWN } from "@/lib/games";
import { GAME_NAMES, type GameId } from "@/lib/mock";

/**
 * The Games a Request and an Offer can name: every listed head-to-head Game, and Railcar (a many-Player Game with its own
 * page and one entry) where it is shown. Backing keeps its own Game type so the head-to-head maps keyed by `GameId` stay
 * as they are.
 */
export type BackedGame = GameId | "railcar";

export const backedGames = (railcar = RAILCAR_SHOWN): BackedGame[] => [...GAME_LIST, ...(railcar ? (["railcar"] as const) : [])];

/** The Game of a Request's or Offer's program; null for a program this app does not show. */
export const backedGameOf = (program: PublicKey, railcar = RAILCAR_SHOWN): BackedGame | null =>
  gameOf(program) ?? (railcar && program.equals(RAILCAR_PROGRAM_ID) ? "railcar" : null);

export const backedProgram = (g: BackedGame): PublicKey => (g === "railcar" ? RAILCAR_PROGRAM_ID : GAME_IDS[g]);

export const backedGameName = (g: BackedGame): string => (g === "railcar" ? "Railcar" : GAME_NAMES[g]);

/** The entries a Request for this Game may ask for, when the Game fixes them (Railcar: 500); null = every entry size. */
export const backedEntries = (g: BackedGame): number[] | null => (g === "railcar" ? [ENTRY_GEMAS] : null);

export const backedHero = (g: BackedGame) => (g === "railcar" ? art.railcarTile : art.hero[g]);
export const backedThumb = (g: BackedGame) => (g === "railcar" ? art.railcarTile : art.thumb[g]);
