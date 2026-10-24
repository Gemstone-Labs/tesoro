import { createHash } from "node:crypto";
import { BN, BorshCoder, type Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import { decodeMatchRecords, type MatchRecord } from "./events";
import { ingestMatchRecords, partiesOf } from "./ingest";
import { reconcileSourceLines, settlementSourceLines, sourceLine, type SourceLineEvidence } from "./source-lines";
import { testDb } from "./test-db";

vi.setConfig({ testTimeout: 60_000 });
const pk = (n: number) => new PublicKey(Buffer.alloc(32, n));
const A = pk(1).toBase58(), B = pk(2).toBase58(), S = pk(3).toBase58();
const core = new PublicKey(coreIdl.address);
const authority = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], core)[0].toBase58();
const tag = Buffer.from("e445a52e51cb9a1d", "hex");
const coder = new BorshCoder(coreIdl as Idl);
const disc = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);
function cpi(name: string, body: Record<string, unknown>) {
  return { programId: core.toBase58(), accounts: [authority], data: Buffer.concat([tag, disc(name), coder.types.encode(name, body)]) };
}
function line(amount: bigint, source = pk(3)) {
  const bytes = Buffer.alloc(144, 0xfe);
  bytes[0] = 0; bytes[1] = 3;
  source.toBuffer().copy(bytes, 11);
  bytes.writeBigUInt64LE(amount, 43);
  return bytes.toString("base64");
}
const base = { opener: A, n: "9", version: 1, finalized: true, signature: "sig" };
function refund(): SourceLineEvidence {
  return {
    header: { finalized: true, signature: "sig", entry_exact: "10", kind: 3, a_funder: A, b_funder: B, b_player: B, fees_exact: ["0", "0", "0"], parties: [{ account: A, delta: 0 }, { account: B, delta: 0 }] },
    settled: { kind: 3, chunks: 2, finalized: true, signature: "sig" },
    records: [
      { ...base, type: "lines-start", event_id: "manifest", pot_lines: [1, 1], studio_owner: null, studio_priority: true },
      ...[A, B].flatMap((recipient, i) => [
        { ...base, type: "line-step", event_id: `step:${i + 1}`, step: i + 1, chunk_no: i + 1, pot_side: i, pot_index: 0, purpose: 3,
          incoming: line(10n), outgoing: line(10n), recipient_kind: 0, recipient, placement: i },
        { ...base, type: "lines-progress", event_id: `progress:${i + 1}`, chunk_no: i + 1, cumulative_steps: i + 1, done: i === 1 },
      ]),
    ],
  };
}
function win(backed = false, studio: "counter" | "priority" | "plain" = "counter"): SourceLineEvidence {
  const feeLine = (amount: bigint, cls: number, side = 0) => {
    const bytes = Buffer.from(line(amount), "base64"); bytes[0] = side; bytes[1] = cls;
    return bytes.toString("base64");
  };
  const owner = studio === "counter" ? null : pk(4).toBase58();
  const operations = [
    { pot_side: 1, purpose: 0, incoming: line(100n), outgoing: feeLine(4n, 0), recipient_kind: 1, recipient: S, placement: 3 },
    { pot_side: 1, purpose: 1, incoming: line(96n), outgoing: feeLine(6n, studio === "plain" ? 3 : 1, studio === "plain" ? 1 : 0), recipient_kind: owner ? 0 : 1, recipient: owner ?? S, placement: owner ? studio === "plain" ? 0 : 255 : 3 },
    { pot_side: 1, purpose: 2, incoming: line(90n), outgoing: feeLine(2n, 2), recipient_kind: 1, recipient: S, placement: 3 },
    { pot_side: 0, purpose: 3, incoming: line(100n), outgoing: line(100n), recipient_kind: 0, recipient: backed ? S : A, placement: 0 },
    { pot_side: 1, purpose: 4, incoming: line(88n), outgoing: feeLine(backed ? 35n : 88n, 3, 1), recipient_kind: 0, recipient: A, placement: 2 },
    ...(backed ? [{ pot_side: 1, purpose: 4, incoming: line(53n), outgoing: feeLine(53n, 3, 1), recipient_kind: 0, recipient: S, placement: 1 }] : []),
  ];
  return {
    header: { signature: "sig", finalized: true, kind: 0, winner_side: 0, a_player: A, a_funder: backed ? S : A, b_player: B, b_funder: B,
      game: "holdem", entry_exact: "100", fees_exact: ["4", "6", "2"],
      parties: [{ account: A, delta_exact: backed ? "35" : "88" }, { account: B, delta_exact: "-100" }, ...(backed ? [{ account: S, delta_exact: "53" }] : [])] },
    won: { signature: "sig", finalized: true, game: "holdem", winner: A, loser: B, entry_exact: "100", pool_fee_exact: "2", points: 5 },
    settled: { signature: "sig", finalized: true, kind: 0, chunks: 1 },
    records: [
      { ...base, type: "lines-start", event_id: "manifest", pot_lines: [1, 1], studio_owner: owner, studio_priority: studio !== "plain" },
      ...operations.map((operation, i) => ({ ...base, ...operation, type: "line-step", event_id: `step:${i + 1}`, step: i + 1, chunk_no: 1, pot_index: 0 })),
      { ...base, type: "lines-progress", event_id: "progress:1", chunk_no: 1, cumulative_steps: operations.length, done: true },
    ],
  };
}
describe("lossless Source-line reconstruction", () => {
  it.each(["counter", "priority", "plain"] as const)("reconciles fees, overflow and a backed split with %s Studio fees", (studio) => {
    const e = win(true, studio);
    expect(reconcileSourceLines(e).reasons).toEqual([]);
    const bad = structuredClone(e); bad.won!.pool_fee_exact = "3";
    expect(reconcileSourceLines(bad).complete).toBe(false);
    const counter = structuredClone(e); counter.records[1].recipient = PublicKey.default.toBase58();
    expect(reconcileSourceLines(counter).complete).toBe(false);
  });
  it("reconstructs by numeric durable order, preserving every snapshot byte and placement", () => {
    const e = refund(); e.records.reverse();
    const result = reconcileSourceLines(e);
    expect(result.reasons).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.originals.map((l) => [l.source, l.amount, l.raw])).toEqual([[S, "10", line(10n)], [S, "10", line(10n)]]);
    expect(result.credits.map((l) => l.placement)).toEqual([0, 1]);
    expect(sourceLine(line(18446744073709551615n)).amount).toBe("18446744073709551615");
  });
  it.each(["manifest", "step:1", "progress:1", "progress:2"])("never marks a stream complete without %s", (missing) => {
    const e = refund(); e.records = e.records.filter((r) => r.event_id !== missing);
    expect(reconcileSourceLines(e).complete).toBe(false);
  });
  it("rejects wrong entries, fee totals, recipients, progress, unknown versions and partial raw lines", () => {
    const corruptions = [
      (e: SourceLineEvidence) => { e.header!.entry_exact = "11"; },
      (e: SourceLineEvidence) => { e.header!.fees_exact = ["1", "0", "0"]; },
      (e: SourceLineEvidence) => { e.records[1].recipient = S; },
      (e: SourceLineEvidence) => { e.records[2].cumulative_steps = 2; },
      (e: SourceLineEvidence) => { e.records[0].version = 2; },
      (e: SourceLineEvidence) => { e.records[1].incoming = "AA=="; },
      (e: SourceLineEvidence) => { e.header!.kind = 0; },
      (e: SourceLineEvidence) => { e.settled!.kind = 0; },
      (e: SourceLineEvidence) => { e.header!.kind = e.settled!.kind = 999; },
    ];
    for (const corrupt of corruptions) { const e = refund(); corrupt(e); expect(reconcileSourceLines(e).complete).toBe(false); }
  });
  it("refuses cross-slot and cross-Source compensation despite an unchanged global total", () => {
    const e = refund();
    e.records[1].outgoing = line(9n);
    e.records[3].outgoing = line(11n);
    expect(reconcileSourceLines(e).complete).toBe(false);
    const swapped = refund(); swapped.records[3].outgoing = line(10n, pk(4));
    expect(reconcileSourceLines(swapped).complete).toBe(false);
  });
  it("refuses swapped refund Sources/recipients even when both totals remain correct", () => {
    const e = refund();
    e.records[1].recipient = B; e.records[3].recipient = A;
    expect(reconcileSourceLines(e).reasons).toContain("invalid original-line return");
  });
  it.each(["gap", "reverse"])("refuses %s chunk boundaries", (kind) => {
    const e = refund();
    if (kind === "gap") { e.records[3].chunk_no = 3; e.records[4].chunk_no = 3; e.settled!.chunks = 3; }
    else { e.records[1].chunk_no = 2; e.records[3].chunk_no = 1; }
    expect(reconcileSourceLines(e).complete).toBe(false);
  });
  it("requires every input in a repeatedly cut Pot slot to match its remaining quantity", () => {
    const e = refund();
    e.records.splice(2, 0, { ...e.records[1], event_id: "step:3", step: 3, chunk_no: 3 });
    e.records.push({ ...base, type: "lines-progress", event_id: "progress:3", chunk_no: 3, cumulative_steps: 3, done: true });
    e.records.find((r) => r.event_id === "progress:2")!.done = false;
    e.settled!.chunks = 3;
    expect(reconcileSourceLines(e).reasons).toContain("Pot slot credit chain mismatch");
  });
});

describe("core Source-line event ingestion", () => {
  it("decodes the actual IDL losslessly and refuses truncated recognized CPIs", () => {
    const item = { pot_side: 0, pot_index_le: [0, 0, 0, 0], purpose: 3, incoming: [...Buffer.from(line(18446744073709551615n), "base64")],
      outgoing: [...Buffer.from(line(1n), "base64")], recipient_kind: 0, recipient: [...pk(2).toBuffer()], placement: 2 };
    const body = { opener: pk(1), n: new BN("18446744073709551615"), record_version: 1, chunk_no: 1, first_step: 1, steps: 1, done: true, blocked: false, overflowed: 1, lines: [item] };
    const ix = cpi("MatchChunkDone", body);
    const record = decodeMatchRecords([ix]).find((r) => r.type === "line-step")!;
    expect(record).toMatchObject({ type: "line-step", n: 18446744073709551615n, incoming: line(18446744073709551615n), outgoing: line(1n), recipient: B, placement: 2 });
    expect(record.coreEvent).toBe(ix.data.toString("base64"));
    expect(() => decodeMatchRecords([{ ...ix, data: ix.data.subarray(0, 19) }])).toThrow(/cursor must wait/);
    expect(decodeMatchRecords([{ ...ix, accounts: [B] }])).toEqual([]);
    for (const length of [66, 70]) {
      const legacy = decodeMatchRecords([{ ...ix, data: ix.data.subarray(0, length) }]);
      expect(legacy).toHaveLength(1);
      expect(legacy[0]).toMatchObject({ type: "chunk", n: 18446744073709551615n, steps: 1, done: true });
    }
    for (const mutate of [
      (data: Buffer) => { data[70] = 2; },
      (data: Buffer) => { data[64] = 2; },
      (data: Buffer) => { data.writeUInt32LE(13, 75); },
    ]) {
      const bad = Buffer.from(ix.data); mutate(bad);
      expect(() => decodeMatchRecords([{ ...ix, data: bad }])).toThrow(/cursor must wait/);
    }
    const retry = cpi("MatchChunkDone", { ...body, steps: 0, first_step: 0, lines: [] });
    expect(decodeMatchRecords([retry]).map((r) => r.type)).toEqual(["chunk"]);
  });
  it("preserves immutable duplicates, rejects conflicting replays and enforces finality/access", async () => {
    const { rpc, sql } = await testDb();
    const evidence = refund();
    for (const p of evidence.records.reverse()) expect(await rpc("ingest_match_line_event", { p })).toBe(true);
    const p = evidence.records.find((r) => r.event_id === "step:1")!;
    expect(await rpc("ingest_match_line_event", { p: { ...p, signature: "retry", slot: 999 } })).toBe(false);
    await expect(rpc("ingest_match_line_event", { p: { ...p, recipient: S } })).rejects.toThrow(/Conflicting/);
    await expect(rpc("ingest_match_line_event", { p: { ...p, finalized: false } })).rejects.toThrow(/finalized/);
    const giant = { ...evidence.records.find((r) => r.event_id === "manifest"), n: "18446744073709551615" };
    expect(await rpc("ingest_match_line_event", { p: giant })).toBe(true);
    const { rows } = await sql.query<{ allowed: boolean }>("select has_function_privilege('anon', 'ingest_match_line_event(jsonb)', 'execute') as allowed");
    expect(rows[0].allowed).toBe(false);
    expect((await sql.query<{ allowed: boolean }>("select has_table_privilege('service_role', 'match_line_events', 'update,delete,truncate') as allowed")).rows[0].allowed).toBe(false);
    await sql.exec("set role service_role");
    expect(await rpc("ingest_match_line_event", { p: giant })).toBe(false);
    await sql.exec("reset role");
    const read = await settlementSourceLines(rpc, { opener: A, n: 9n });
    expect(read.evidence.records).toHaveLength(5);
    expect(read.complete).toBe(false); // no header/settled record has arrived yet
    const start: MatchRecord = { type: "start", opener: A, n: 9n, game: core.toBase58(), kind: 3, winnerSide: null, entry: 10,
      fees: [0, 0, 0], aPlayer: A, aFunder: A, bPlayer: B, bFunder: B, challenge: false, asset: 0, openedAt: 1, ts: 2, aShareBps: 0, bShareBps: 0 };
    await ingestMatchRecords(rpc, [start, { type: "settled", opener: A, n: 9n, kind: 3, chunks: 2 }], { gameOf: () => "holdem", finalized: true, signature: "sig" });
    expect((await settlementSourceLines(rpc, { opener: A, n: 9n })).complete).toBe(true);
    for (const field of ["pot_side", "purpose", "recipient_kind", "placement"]) {
      const missing: Record<string, unknown> = { ...p, n: "10" }; delete missing[field];
      await expect(rpc("ingest_match_line_event", { p: missing })).rejects.toThrow(/Invalid/);
    }
    await sql.close();
  });
  it("computes Backing deltas exactly before converting display values", () => {
    const record = { type: "start" as const, opener: A, n: 9n, game: core.toBase58(), kind: 0, winnerSide: 0 as const,
      entry: 9007199254740990, entryExact: "9007199254740990", fees: [0, 0, 0] as [number, number, number], aPlayer: A, aFunder: S,
      bPlayer: B, bFunder: B, challenge: false, asset: 0, openedAt: 1, ts: 2, aShareBps: 3333, bShareBps: 0 };
    expect(partiesOf(record)[0].delta_exact).toBe("3002099511605171");
  });
  it("dispatches line records to their own idempotent RPC and refuses confirmed ingestion", async () => {
    const sink = vi.fn().mockResolvedValue(true);
    const record: MatchRecord = { type: "lines-start", opener: A, n: 9n, version: 1, potLines: [1, 1], studioOwner: null, studioPriority: true };
    await expect(ingestMatchRecords(sink, [record], { gameOf: () => null })).rejects.toThrow(/finalized/);
    expect(sink).not.toHaveBeenCalled();
    await ingestMatchRecords(sink, [record], { gameOf: () => null, finalized: true });
    expect(sink.mock.calls[0][0]).toBe("ingest_match_line_event");
  });
  it("refuses an unfinalized transaction before its first immutable legacy header can be written", async () => {
    const sink = vi.fn().mockResolvedValue(true);
    const start: MatchRecord = { type: "start", opener: A, n: 9n, game: core.toBase58(), kind: 3, winnerSide: null, entry: 10,
      fees: [0, 0, 0], aPlayer: A, aFunder: A, bPlayer: B, bFunder: B, challenge: false, asset: 0, openedAt: 1, ts: 2, aShareBps: 0, bShareBps: 0 };
    const manifest: MatchRecord = { type: "lines-start", opener: A, n: 9n, version: 1, potLines: [1, 1], studioOwner: null, studioPriority: true };
    await expect(ingestMatchRecords(sink, [start, manifest], { gameOf: () => "holdem", finalized: false })).rejects.toThrow(/finalized/);
    expect(sink).not.toHaveBeenCalled();
    expect(await ingestMatchRecords(sink, [start, manifest], { gameOf: () => "holdem", finalized: true })).toBe(2);
    expect(sink.mock.calls.map(([fn, { p }]) => [fn, p.finalized])).toEqual([["ingest_match_event", true], ["ingest_match_line_event", true]]);
  });
});
