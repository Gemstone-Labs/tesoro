import { PublicKey } from "@solana/web3.js";
import coreIdl from "../../app/src/lib/chain/idl/tesoro_core.json" with { type: "json" };
import railcarIdl from "../../app/src/lib/chain/idl/railcar.json" with { type: "json" };
import { gameOfProgram } from "../../app/src/lib/chain/games.ts";
import type { MatchRecord } from "../../app/src/server/history/events.ts";
import { ingestMatchRecords } from "../../app/src/server/history/ingest.ts";
import { matchKeyOf } from "../../app/src/server/history/match-key.ts";
import type { Rpc } from "../../app/src/server/history/rpc.ts";
import { recordsOfRawTx, type RawTx } from "../../app/src/server/history/webhook.ts";
import { pooled } from "./events-scan.ts";

/**
 * Staging-only: the Railcar rows of the Match history while production's decoder (main) skips Railcar.
 *
 * Production stores every core transaction in webhook_tx and marks it decoded, so its own catch-up never offers a ride's
 * transactions again. This pass reads them from the chain instead (core's and Railcar's event authorities), decodes them
 * with this branch's decoder and writes only the many-seat pieces through `ingest_match_event`, which dedupes by event id
 * and rebuilds the parties. It never writes webhook_tx and never writes a head-to-head Match.
 */

const eventAuthorityOf = (program: string) => PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], new PublicKey(program))[0].toBase58();
export const CORE_EVENT_AUTHORITY = eventAuthorityOf(coreIdl.address);
export const RAILCAR_EVENT_AUTHORITY = eventAuthorityOf(railcarIdl.address);

export interface RideChain {
  /** Finalized, successful signatures that list `address`, with a block time at or after `sinceTs` (unix seconds). */
  signatures(address: string, sinceTs: number): Promise<string[]>;
  /** The finalized transaction (json encoding); null when it cannot be read. */
  transaction(signature: string): Promise<RawTx | null>;
}

/** A record only a many-seat Match has: its run start, its ride, or a chunk with seat lines. */
const marksManySeat = (r: MatchRecord) => r.type === "seats-start" || r.type === "ride" || (r.type === "chunk" && r.seatLines !== undefined);
const MANY_SEAT_TYPES = new Set<MatchRecord["type"]>(["seats-start", "ride", "chunk", "settled", "won"]);

/** The records of the many-seat Matches in one transaction; every head-to-head record is dropped. */
export function manySeatRecords(records: MatchRecord[]): MatchRecord[] {
  const manySeat = new Set(records.filter(marksManySeat).map(matchKeyOf));
  return records.filter((r) => manySeat.has(matchKeyOf(r)) && MANY_SEAT_TYPES.has(r.type));
}

export interface PassDeps {
  chain: RideChain;
  /** The history database; may be null for a dry run. */
  rpc: Rpc | null;
  sinceTs: number;
  dryRun: boolean;
  /** Signatures fully handled by an earlier pass of this process: not fetched again. */
  seen?: Set<string>;
  log?: (line: string) => void;
}

export interface PassResult {
  scanned: number;
  /** Every many-seat Match with pieces in the window, `<opener>-<n>`. */
  matches: string[];
  /** Pieces `ingest_match_event` stored as new (0 on a dry run). */
  added: number;
  /** Signatures that could not be read or decoded; they are tried again on the next pass. */
  failed: string[];
}

export async function railcarHistoryPass(deps: PassDeps): Promise<PassResult> {
  const say = deps.log ?? (() => undefined);
  if (!deps.dryRun && !deps.rpc) throw new Error("writing needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const seen = deps.seen ?? new Set<string>();
  const listed = await Promise.all([CORE_EVENT_AUTHORITY, RAILCAR_EVENT_AUTHORITY].map((a) => deps.chain.signatures(a, deps.sinceTs)));
  const fresh = [...new Set(listed.flat())].filter((s) => !seen.has(s));
  const txs = await pooled(fresh, 4, async (signature) => ({ signature, tx: await deps.chain.transaction(signature).catch(() => null) }));
  txs.sort((a, b) => (a.tx?.slot ?? 0) - (b.tx?.slot ?? 0) || a.signature.localeCompare(b.signature));

  const matches = new Set<string>();
  const failed: string[] = [];
  let added = 0;
  for (const { signature, tx } of txs) {
    if (!tx) {
      failed.push(signature);
      say(`${signature} not readable yet`);
      continue;
    }
    let pieces: MatchRecord[];
    try {
      pieces = manySeatRecords(recordsOfRawTx(tx));
    } catch (e) {
      failed.push(signature);
      say(`${signature} not decodable: ${String((e as Error).message ?? e).split("\n")[0]}`);
      continue;
    }
    if (pieces.length) {
      for (const k of new Set(pieces.map(matchKeyOf))) matches.add(k);
      const what = pieces.map((p) => (p.type === "chunk" ? `chunk:${p.chunkNo}` : p.type)).join(" ");
      if (deps.dryRun) say(`would ingest ${[...new Set(pieces.map(matchKeyOf))].join(",")} ${what} from ${signature}`);
      else {
        const n = await ingestMatchRecords(deps.rpc!, pieces, { signature, slot: tx.slot, blockTime: tx.blockTime ?? undefined, finalized: true, gameOf: (p) => gameOfProgram(new PublicKey(p)) });
        added += n;
        say(`ingested ${[...new Set(pieces.map(matchKeyOf))].join(",")} ${what} from ${signature}: ${n} new`);
      }
    }
    seen.add(signature);
  }
  return { scanned: txs.length, matches: [...matches], added, failed };
}

/** The chain over plain JSON-RPC (finalized). */
export function jsonRpcRideChain(url: string, fetchFn: typeof fetch = fetch): RideChain {
  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetchFn(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (res.status === 429 && attempt < 5) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) throw new Error(`${method} failed: ${res.status}`);
      const json = (await res.json()) as { result?: T; error?: { message: string } };
      if (json.error) throw new Error(`${method} failed: ${json.error.message}`);
      return json.result as T;
    }
  };
  return {
    signatures: async (address, sinceTs) => {
      const out: string[] = [];
      let before: string | undefined;
      for (;;) {
        const page = await call<{ signature: string; err: unknown; blockTime: number | null }[]>("getSignaturesForAddress", [address, { before, limit: 1000, commitment: "finalized" }]);
        const inWindow = page.filter((s) => (s.blockTime ?? 0) >= sinceTs);
        out.push(...inWindow.filter((s) => !s.err).map((s) => s.signature));
        if (page.length < 1000 || inWindow.length < page.length) return out;
        before = page[page.length - 1].signature;
      }
    },
    transaction: (signature) => call<RawTx | null>("getTransaction", [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "finalized" }]),
  };
}
