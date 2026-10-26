/**
 * Retiring the per-Match game records from before persistent tables (Block Burst `Board`, Hold'em `Hole`, Vanguard `Army`).
 * Pure: classifies a snapshot of one game program's accounts and builds `retire_legacy_account` from the IDL. The lengths come
 * from the program's own constant (`LEGACY_*_LENGTHS`, written to keeper/fixtures/*-layouts.json by its Rust fixture test), never
 * hand-copied. The signer is the game's operator (`TableConfig.operator`). Devnet state is disposable (founder, 2026-10-25):
 * these are closed, never migrated. `keeper/scripts/retire-old-accounts.ts --games` reads the chain and sends.
 */
import anchor, { type Idl, type Program } from "@coral-xyz/anchor";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import blockPuzzleIdl from "../../app/src/lib/chain/idl/block_puzzle.json" with { type: "json" };
import holdemIdl from "../../app/src/lib/chain/idl/holdem.json" with { type: "json" };
import vanguardIdl from "../../app/src/lib/chain/idl/vanguard.json" with { type: "json" };
import blockPuzzleFx from "../fixtures/block-puzzle-layouts.json" with { type: "json" };
import holdemFx from "../fixtures/holdem-layouts.json" with { type: "json" };
import vanguardFx from "../fixtures/vanguard-layouts.json" with { type: "json" };

export type Game = "block_puzzle" | "holdem" | "vanguard";
export const GAMES: Game[] = ["block_puzzle", "holdem", "vanguard"];

interface Spec {
  idl: Idl & { address: string };
  /** The IDL account type of the old per-Match record. */
  type: string;
  /** Seed of the TableConfig PDA and its name in the instruction's accounts. */
  configSeed: string;
  configAccount: "config" | "tableConfig";
  fixtures: Record<string, string>;
}
const SPECS: Record<Game, Spec> = {
  block_puzzle: { idl: blockPuzzleIdl as never, type: "Board", configSeed: "config", configAccount: "config", fixtures: blockPuzzleFx },
  holdem: { idl: holdemIdl as never, type: "Hole", configSeed: "config", configAccount: "config", fixtures: holdemFx },
  vanguard: { idl: vanguardIdl as never, type: "Army", configSeed: "tables", configAccount: "tableConfig", fixtures: vanguardFx },
};

export const programOf = (g: Game) => new PublicKey(SPECS[g].idl.address);
export const typeOf = (g: Game) => SPECS[g].type;
export const configOf = (g: Game) => PublicKey.findProgramAddressSync([Buffer.from(SPECS[g].configSeed)], programOf(g))[0];

/** The exact record lengths `retire_legacy_account` closes, from the program's Rust constant. */
export function legacyLengths(g: Game): number[] {
  const hex = SPECS[g].fixtures["legacy_lengths_u16le"];
  if (!hex) throw new Error(`${g}: keeper/fixtures has no legacy_lengths_u16le; regenerate with UPDATE_KEEPER_FIXTURES=1`);
  const b = Buffer.from(hex, "hex");
  return Array.from({ length: b.length / 2 }, (_, i) => b.readUInt16LE(2 * i));
}

function discriminator(g: Game): Buffer {
  const a = (SPECS[g].idl as unknown as { accounts: { name: string; discriminator: number[] }[] }).accounts.find((x) => x.name === SPECS[g].type);
  if (!a) throw new Error(`${g}: IDL has no ${SPECS[g].type}`);
  return Buffer.from(a.discriminator);
}

export interface Row {
  pubkey: PublicKey;
  data: Buffer;
}
export interface GameItem {
  game: Game;
  key: PublicKey;
  size: number;
}

/** The records to close: the right discriminator and one of the exact retire-only lengths. Current-layout records and every other type are left. */
export function planGame(g: Game, rows: Row[]): { items: GameItem[]; left: number } {
  const disc = discriminator(g);
  const lengths = legacyLengths(g);
  const items: GameItem[] = [];
  for (const r of rows) if (r.data.length >= 8 && r.data.subarray(0, 8).equals(disc) && lengths.includes(r.data.length)) items.push({ game: g, key: r.pubkey, size: r.data.length });
  return { items, left: rows.length - items.length };
}

/** Instructions per transaction. */
export const GAME_BATCH = 10;

export function gameProgram(g: Game): Program {
  return new anchor.Program(SPECS[g].idl as Idl, {} as never);
}

export async function buildGameIx(program: Program, g: Game, operator: PublicKey, item: GameItem): Promise<TransactionInstruction> {
  const accounts = { operator, [SPECS[g].configAccount]: configOf(g), account: item.key };
  return (program.methods as unknown as { retireLegacyAccount(): { accountsStrict(a: unknown): { instruction(): Promise<TransactionInstruction> } } }).retireLegacyAccount().accountsStrict(accounts).instruction();
}
