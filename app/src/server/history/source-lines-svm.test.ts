import { readFileSync } from "node:fs";
import { PublicKey } from "@solana/web3.js";
import { expect, it, vi } from "vitest";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import { decodeMatchRecords } from "./events";
import { ingestMatchRecords } from "./ingest";
import { matchKeyOf } from "./match-key";
import { settlementSourceLines } from "./source-lines";
import { testDb } from "./test-db";

vi.setConfig({ testTimeout: 60_000 });

it("rebuilds four many-Source settlements from actual LiteSVM event-CPI bytes, in any order", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/source-line-events.json", import.meta.url), "utf8")) as {
    environment: string; elfSha256: string; transactions: { world: number; phase: string; signature: string; events: string[] }[];
  };
  expect(fixture.environment).toBe("LiteSVM; not deployed chain evidence");
  expect(fixture.elfSha256).toMatch(/^[a-f0-9]{64}$/);
  const core = new PublicKey(coreIdl.address);
  const authority = PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], core)[0].toBase58();
  const transactions = fixture.transactions.map((tx, i) => ({
    world: tx.world, phase: tx.phase, signature: tx.signature, slot: i + 1,
    records: decodeMatchRecords(tx.events.map((hex) => ({ programId: core.toBase58(), accounts: [authority], data: Buffer.from(hex, "hex") }))),
  }));
  const worlds = [...new Set(transactions.map((tx) => tx.world))];
  expect(worlds).toHaveLength(4);
  const counts: number[] = [];
  // Each Rust case starts an independent LiteSVM world, whose deterministic Match id may repeat.
  for (const world of worlds) {
    const { rpc, sql } = await testDb();
    const txs = transactions.filter((tx) => tx.world === world);
    const retry = txs.find((tx) => tx.phase === "closed-retry");
    expect(retry?.records.map((r) => r.type)).toEqual(["chunk"]);
    const ids = new Map(txs.flatMap((tx) => tx.records.filter((r) => r.type === "lines-start").map((r) => [matchKeyOf(r), r] as const)));
    expect(ids.size).toBe(1);
    for (const tx of [...txs].reverse()) {
      await ingestMatchRecords(rpc, tx.records, { ...tx, finalized: true, gameOf: (key) => key });
    }
    const settled = await sql.query<{ signature: string }>("select signature from match_events where type = 'settled'");
    expect(settled.rows).toEqual([{ signature: txs.find((tx) => tx.records.some((r) => r.type === "settled"))!.signature }]);
    expect(settled.rows[0].signature).not.toBe(retry!.signature);
    for (const id of ids.values()) {
      const result = await settlementSourceLines(rpc, id);
      expect(result.reasons).toEqual([]);
      expect(result.complete).toBe(true);
      const distinct = new Set(result.originals.map((l) => l.source)).size;
      counts.push(distinct);
      expect(result.originals).toHaveLength(2 * distinct);
      expect(result.credits.reduce((sum, line) => sum + BigInt(line.amount), 0n)).toBe(2000n);
    }
    for (const tx of txs) {
      expect(await ingestMatchRecords(rpc, tx.records, { ...tx, finalized: true, gameOf: (key) => key })).toBe(0);
    }
    await sql.close();
  }
  expect(counts.sort((a, b) => a - b)).toEqual([4, 5, 8, 10]);
});
