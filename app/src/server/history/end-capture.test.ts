import { readFileSync } from "node:fs";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import { GAME_IDS } from "../../lib/chain/games";
import blockPuzzleIdl from "../../lib/chain/idl/block_puzzle.json";
import holdemIdl from "../../lib/chain/idl/holdem.json";
import duelIdl from "../../lib/chain/idl/trading_duel.json";
import vanguardIdl from "../../lib/chain/idl/vanguard.json";
import layout from "../../games/vanguard/chain-layout.json";
import { captureEndStates, type BaseReader } from "./end-capture";
import { endStateOf } from "./end-state";
import { recordsOfRawTx, slim, type RawTx, type StoredTx } from "./webhook";
import { testDb } from "./test-db";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type Game = "holdem" | "trading-duel" | "block-puzzle" | "vanguard";
const IDLS = { holdem: holdemIdl, "trading-duel": duelIdl, "block-puzzle": blockPuzzleIdl, vanguard: vanguardIdl } as const;
const templates = JSON.parse(readFileSync(new URL("./fixtures/base-tables-devnet.json", import.meta.url), "utf8")) as Record<Game, { table: string; battle?: string; address: string }>;
const delivery = JSON.parse(readFileSync(new URL("./fixtures/helius-delivery-real-2026-11-04.json", import.meta.url), "utf8")) as RawTx[];

/** The real Hold'em finalize delivery (a win), moved onto `game`'s program and `table`. */
const FINALIZE_SLOT = 518491929;
const MATCH = "5WZGmUSxZxQk3o6mqiyHy7QLHRf4WqXfdMLyLcgQVjBv";
function finalizeTx(game: Game, table: string): StoredTx {
  const tx = structuredClone(delivery.find((t) => t.slot === FINALIZE_SLOT)!);
  const keys = tx.transaction.message.accountKeys;
  const ix = tx.transaction.message.instructions![2];
  keys[ix.programIdIndex] = GAME_IDS[game].toBase58();
  keys[ix.accounts[2]] = table;
  return { signature: tx.transaction.signatures[0], slot: tx.slot, blockTime: tx.blockTime ?? null, body: slim(tx) };
}

const programOf = (game: Game) => new Program(IDLS[game] as never, { connection: {} } as never);
/** The template Table bytes, re-encoded as a Table of `match` in `phase` with `patch` applied. */
function tableBytes(game: Game, match: string, phase: number, patch: Record<string, unknown> = {}) {
  const coder = programOf(game).coder.accounts;
  const raw = coder.decode("table", Buffer.from(templates[game].table, "base64"));
  // The coder's own encode allocates 1,000 bytes; Block Burst's Table is 9 KB, so write through its layout.
  const template = Buffer.from(templates[game].table, "base64");
  const layout = (coder as unknown as { accountLayouts: Map<string, { layout: { encode(o: unknown, b: Buffer): number } }> }).accountLayouts.get("table")!.layout;
  const out = Buffer.from(template);
  layout.encode({ ...raw, tesoroMatch: new PublicKey(match), phase, ...patch }, out.subarray(8));
  return out;
}
function battleBytes(match: string, status: number) {
  const b = Buffer.from(templates.vanguard.battle!, "base64");
  new PublicKey(match).toBuffer().copy(b, layout.battle.offsets.tesoroMatch);
  b[layout.battle.offsets.status] = status;
  b[layout.battle.offsets.usSeat] = 0;
  return b;
}

const OVER: Record<Game, number> = { holdem: 3, "trading-duel": 3, "block-puzzle": 4, vanguard: 3 };
const PATCH: Partial<Record<Game, Record<string, unknown>>> = {};

function baseOf(accounts: Record<string, Uint8Array | null>, reads: { address: string; minSlot: number }[] = []): BaseReader {
  return { read: async (address, minSlot) => (reads.push({ address, minSlot }), accounts[address] ?? null) };
}

describe("the real delivery", () => {
  it("is a Hold'em win for the Match the finalize names", () => {
    const records = recordsOfRawTx(delivery.find((t) => t.slot === FINALIZE_SLOT)!);
    expect(records.filter((r) => r.type === "start").map((r) => (r as { kind: number }).kind)).toEqual([0]);
  });
});

describe.each(["holdem", "trading-duel", "block-puzzle", "vanguard"] as Game[])("final board of a %s Match", (game) => {
  const table = templates[game].address;
  const patch = async (reads: { address: string; minSlot: number }[] = []) => {
    const accounts: Record<string, Uint8Array | null> = { [table]: await tableBytes(game, MATCH, OVER[game], PATCH[game]) };
    if (game === "vanguard") accounts[Object.keys(templates).includes("vanguard") ? battleKey(table) : ""] = battleBytes(MATCH, 3);
    return baseOf(accounts, reads);
  };

  it("is read from base when the finalize arrives, at the finalize's slot, and stored under the Match", async () => {
    const { rpc } = await testDb();
    const reads: { address: string; minSlot: number }[] = [];
    const out = await captureEndStates({ rpc, base: await patch(reads) }, finalizeTx(game, table));
    expect(out).toEqual([{ match: MATCH, game, outcome: "captured" }]);
    const stored = await endStateOf(rpc, MATCH);
    expect(stored?.game).toBe(game);
    expect(reads.every((r) => r.minSlot === FINALIZE_SLOT)).toBe(true);
    expect(reads.map((r) => r.address)).toContain(table);
  });

  it("is stored once: a repeat delivery reads nothing", async () => {
    const { rpc } = await testDb();
    const deps = { rpc, base: await patch() };
    await captureEndStates(deps, finalizeTx(game, table));
    const reads: { address: string; minSlot: number }[] = [];
    const again = await captureEndStates({ rpc, base: await patch(reads) }, finalizeTx(game, table));
    expect(again).toEqual([{ match: MATCH, game, outcome: "already" }]);
    expect(reads).toEqual([]);
  });

  it("marks the board missing when base's Table already belongs to a later Match", async () => {
    const { rpc, sql } = await testDb();
    const later = "9A69s3m8ZQdJ4cS8xv9N2dTz1kYbq7R4tHgW5aXe3Lp1";
    const accounts: Record<string, Uint8Array | null> = { [table]: await tableBytes(game, later, OVER[game]) };
    if (game === "vanguard") accounts[battleKey(table)] = battleBytes(later, 3);
    const out = await captureEndStates({ rpc, base: baseOf(accounts) }, finalizeTx(game, table));
    expect(out).toMatchObject([{ match: MATCH, outcome: "missing" }]);
    expect(await endStateOf(rpc, MATCH)).toBeNull();
    expect((await sql.query("select reason from match_end_missing where match_address = $1", [MATCH])).rows).toHaveLength(1);
  });

  it("lets a later capture replace the missing marker", async () => {
    const { rpc, sql } = await testDb();
    const later = "9A69s3m8ZQdJ4cS8xv9N2dTz1kYbq7R4tHgW5aXe3Lp1";
    const gone: Record<string, Uint8Array | null> = { [table]: await tableBytes(game, later, OVER[game]) };
    await captureEndStates({ rpc, base: baseOf(gone) }, finalizeTx(game, table));
    const out = await captureEndStates({ rpc, base: await patch() }, finalizeTx(game, table));
    expect(out[0].outcome).toBe("captured");
    expect((await sql.query("select 1 from match_end_missing")).rows).toHaveLength(0);
  });

  it("marks missing, never guesses, when the Table is not Over", async () => {
    const { rpc } = await testDb();
    const live = { [table]: await tableBytes(game, MATCH, 2) };
    if (game === "vanguard") (live as Record<string, Uint8Array>)[battleKey(table)] = battleBytes(MATCH, 3);
    const out = await captureEndStates({ rpc, base: baseOf(live) }, finalizeTx(game, table));
    expect(out[0].outcome).toBe("missing");
    expect(await endStateOf(rpc, MATCH)).toBeNull();
  });

  it("reports a failed read as an error and writes nothing, so a retry is possible", async () => {
    const { rpc, sql } = await testDb();
    const base: BaseReader = { read: async () => { throw new Error("rpc down"); } };
    const out = await captureEndStates({ rpc, base }, finalizeTx(game, table));
    expect(out[0].outcome).toBe("error");
    expect((await sql.query("select 1 from match_end_missing")).rows).toHaveLength(0);
  });
});

describe("what is not a settled Match", () => {
  it("ignores a transaction with no finalize of a Game", async () => {
    const { rpc } = await testDb();
    const tx = delivery.find((t) => t.slot !== FINALIZE_SLOT)!;
    const out = await captureEndStates({ rpc, base: baseOf({}) }, { signature: "s", slot: tx.slot, blockTime: null, body: slim(tx) });
    expect(out).toEqual([]);
  });
});

import { battlePda, tablePda } from "../../games/vanguard/chain";
function battleKey(table: string) {
  return battlePda(new PublicKey(table)).toBase58();
}
void tablePda;
