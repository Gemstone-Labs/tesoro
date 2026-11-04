import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { log } from "./act.ts";
import { discriminatorOf } from "./lists.ts";

/**
 * The safety sweep: finishes what a Player who left would have finished. One run reads the Matches, sends the steps that
 * are due and exits; a timer starts it every 5 minutes. Three cases:
 *  - `finalize`: an Active Match whose result base's committed table already holds, 10 minutes after the sweep first saw it
 *    committed: `finalize`, then the chunks, then `close_match`;
 *  - `finish`: a Settling, Refunding or Closed Match, 10 minutes after the sweep first saw it: the chunks, then `close_match`;
 *  - `refund`: an Open Match a Backer funded that nobody joined, once its deadline has passed: `refund_match`.
 * Every send is idempotent, so a page that did the step first costs nothing. A Match the sweep tried once and finds in the
 * same state on the next sweep is stuck: it raises an alert and is not retried.
 */

/** A Match must have been waiting this long (seconds) before the sweep steps in for the Players. */
/** Sends that left a Match at the same place before it is called stuck. */
export const TRIES_BEFORE_ALERT = 2;
/** Sweeps in a row whose send threw before the Match is called stuck (30 minutes at one sweep per 5). */
export const ERRORS_BEFORE_ALERT = 6;
/** An alerted Match is retried this often. */
export const RETRY_ALERTED_SECS = 3600;
/** A full chain scan runs at least this often (seconds); the runs between take their candidates from the database. */
export const FULL_SCAN_SECS = Number(process.env.KEEPER_SWEEP_FULL_SCAN_SECS ?? 60 * 60);
export const GRACE_SECS = Number(process.env.KEEPER_SWEEP_GRACE_SECS ?? 10 * 60);

export type Stage = "open" | "active" | "settling" | "refunding" | "closed";
const STAGES: Stage[] = ["open", "active", "settling", "refunding", "closed"];

/** The few facts of a Match the sweep picks candidates from. */
export interface Head {
  address: PublicKey;
  game: PublicKey;
  stage: Stage;
  /** A second side joined. */
  joined: boolean;
  /** The opener's entry was funded by a Backer. */
  backed: boolean;
  openedAt: number;
  deadline: number;
}

/**
 * Bytes of a Match account the sweep reads: through the `stage` byte of the longest layout. The byte's offset moves with the two
 * optional fields before it (the outside Studio and the second side), so it cannot be a `memcmp`; the slice keeps each row small.
 */
export const SLICE_LEN = 340;

const KEY_LEN = 32;
const TERMS_AT = 8 + 1 + 40 + 3 + KEY_LEN + KEY_LEN + 8;

let discriminator: Buffer | null = null;

/** Reads a Match's head from the first `SLICE_LEN` bytes of its account; null when the row is not a Match. */
export function headOf(address: PublicKey, data: Buffer): Head | null {
  discriminator ??= discriminatorOf("MatchState");
  if (data.length < SLICE_LEN || !data.subarray(0, 8).equals(discriminator)) return null;
  const game = new PublicKey(data.subarray(8 + 1 + 40 + 3, 8 + 1 + 40 + 3 + KEY_LEN));
  const studioSome = data[TERMS_AT + 4] === 1;
  const entryAt = TERMS_AT + 4 + 1 + (studioSome ? KEY_LEN : 0) + 1;
  const openedAt = Number(data.readBigInt64LE(entryAt + 8));
  const deadline = Number(data.readBigInt64LE(entryAt + 16));
  const partyAt = entryAt + 32;
  const backed = !data.subarray(partyAt, partyAt + KEY_LEN).equals(data.subarray(partyAt + KEY_LEN, partyAt + 2 * KEY_LEN));
  const bAt = partyAt + 2 * KEY_LEN + 2;
  const joined = data[bAt] === 1;
  const stageAt = bAt + 1 + (joined ? 2 * KEY_LEN + 2 : 0) + 8;
  const stage = STAGES[data[stageAt]];
  return stage ? { address, game, stage, joined, backed, openedAt, deadline } : null;
}

// ---- state kept between runs -------------------------------------------------------------------------------------

/** What the sweep remembers about a Match it has met. */
export interface Seen {
  /** When the sweep first found it waiting. */
  since: number;
  /** The Match's progress that `tries` and `errors` count at; they restart when the Match moves. Absent before the first attempt. */
  triedAt?: string;
  /** Sends that went out and left the Match at `triedAt`. */
  tries?: number;
  /** Sweeps in a row at `triedAt` whose send threw (a 429, a failed simulation): not tries, the send may not have gone out. */
  errors?: number;
  /** When the sweep last sent or attempted a step. */
  lastTryAt?: number;
  /** An alert was raised for it; it is retried once an hour so it can recover, and the alert clears when it moves. */
  alerted?: boolean;
}

export interface SweepState {
  seen: Record<string, Seen>;
  /** When the last full chain scan finished (unix seconds). */
  fullScanAt?: number;
}

export interface SweepStore {
  load(): SweepState;
  save(state: SweepState): void;
}

export const memorySweepStore = (initial: SweepState = { seen: {} }): SweepStore => {
  let state = structuredClone(initial);
  return { load: () => structuredClone(state), save: (s) => void (state = structuredClone(s)) };
};

/** A SweepState kept in a JSON file; a missing or unreadable file is no state. */
export function fileSweepStore(path: string): SweepStore {
  return {
    load() {
      try {
        return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as SweepState) : { seen: {} };
      } catch {
        return { seen: {} };
      }
    },
    save(state) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(state));
    },
  };
}

// ---- the sweep ----------------------------------------------------------------------------------------------------

/** What the sweep reaches the chain through: tests replace it. */
export interface SweepDeps {
  /** Every Match, read as heads (a sliced, paged scan). */
  scan(): Promise<Head[]>;
  /**
   * The Matches the database (fed by the Helius webhook) says still have an account. With `readHeads` this lets a run skip the
   * scan; without them every run scans. Throws when the database cannot be read.
   */
  dbMatches?(): Promise<PublicKey[]>;
  /** Reads these Match accounts by address; `gone` lists the ones that no longer exist. */
  readHeads?(addresses: PublicKey[]): Promise<{ heads: Head[]; gone: PublicKey[] }>;
  /** Tells the database these Match accounts no longer exist. */
  markGone?(addresses: PublicKey[]): Promise<void>;
  /** Base's committed copy of the Match's Table holds its result (so `finalize` would settle it). */
  committed(head: Head): Promise<boolean>;
  /** Where the Match is now: a key that changes when a step lands; null once it is closed away. */
  progress(address: PublicKey): Promise<string | null>;
  finalize(head: Head): Promise<void>;
  /** The chunks, then `close_match`, as far as they go. Throws when a step fails with the Match unmoved. */
  finish(address: PublicKey): Promise<void>;
  refund(head: Head): Promise<void>;
}

export type Case = "finalize" | "finish" | "refund";

export interface Candidate {
  address: PublicKey;
  case: Case;
  /** Seconds the sweep has known it waiting. */
  ageSecs: number;
  /** `send`: steps due now; `wait`: inside the grace; `stuck`: already tried at this place, alerted. */
  action: "send" | "wait" | "stuck";
}

export interface SweepReport {
  /** Matches the scan returned, by stage. */
  scanned: Partial<Record<Stage, number>>;
  candidates: Candidate[];
  /** Every Match currently stuck (the unit fails while there are any). */
  alerts: string[];
  /** Alerts raised by this run. */
  newAlerts: string[];
  /** `db`: candidates came from the database; `full`: the hourly chain scan; `fallback`: the database failed, so the chain was scanned. */
  mode: "db" | "full" | "fallback";
  /** Found by a full scan with something to do, but unknown to the database (the webhook missed them). */
  dbMisses: string[];
}

/** Thrown by a send that did not go out for a reason that is no fault of the Match (the hourly spend cap): not counted as a try. */
export class Deferred extends Error {}

const label = (a: PublicKey) => a.toBase58();

/** Picks the case a head falls in; `finalize` also needs the committed check, made by the caller. */
function caseOf(h: Head, now: number): Case | null {
  if (h.stage === "open") return !h.joined && h.backed && now > h.deadline ? "refund" : null;
  if (h.stage === "active") return now - h.openedAt >= GRACE_SECS ? "finalize" : null;
  return "finish";
}

/**
 * Where this run's Matches come from. Between hourly scans: the database's Matches plus any Match the sweep already tracks,
 * read by address. Hourly (or when the database is unavailable): the full chain scan, as before.
 */
async function findHeads(deps: SweepDeps, state: SweepState, now: number, dryRun: boolean, forceFull: boolean, report: SweepReport, next: SweepState) {
  const hasDb = !!(deps.dbMatches && deps.readHeads);
  const full = !hasDb || forceFull || now - (state.fullScanAt ?? 0) >= FULL_SCAN_SECS;
  let dbAddresses: PublicKey[] | null = null;
  if (hasDb) {
    try {
      dbAddresses = await deps.dbMatches!();
    } catch (e) {
      log("sweep", "-", `database unreadable (${String((e as Error).message ?? e).split("\n")[0].slice(0, 160)}): scanning the chain`);
      report.mode = "fallback";
    }
  }
  const tellGone = async (gone: PublicKey[]) => {
    if (!gone.length || dryRun) return;
    await deps.markGone!(gone).catch((e) => log("sweep", "-", `could not tell the database ${gone.length} Match(es) are gone: ${String((e as Error).message ?? e).slice(0, 160)}`));
  };
  if (hasDb && dbAddresses && !full) {
    const tracked = Object.keys(state.seen).map((k) => new PublicKey(k));
    const byId = new Map([...dbAddresses, ...tracked].map((a) => [label(a), a]));
    const { heads, gone } = await deps.readHeads!([...byId.values()]);
    await tellGone(gone);
    report.mode = "db";
    return { heads, dbIds: null as Set<string> | null };
  }
  const heads = await deps.scan();
  if (report.mode !== "fallback") report.mode = "full";
  if (!dryRun) next.fullScanAt = now;
  if (!dbAddresses) return { heads, dbIds: null };
  const live = new Set(heads.map((h) => label(h.address)));
  await tellGone(dbAddresses.filter((a) => !live.has(label(a))));
  return { heads, dbIds: new Set(dbAddresses.map(label)) };
}

export async function safetySweep(deps: SweepDeps, store: SweepStore, opts: { now: number; dryRun?: boolean; full?: boolean }): Promise<SweepReport> {
  const { now, dryRun = false, full = false } = opts;
  const state = store.load();
  const next: SweepState = { seen: {}, fullScanAt: state.fullScanAt };
  const report: SweepReport = { scanned: {}, candidates: [], alerts: [], newAlerts: [], mode: "full", dbMisses: [] };

  const { heads, dbIds } = await findHeads(deps, state, now, dryRun, full, report, next);

  for (const head of heads) {
    report.scanned[head.stage] = (report.scanned[head.stage] ?? 0) + 1;
    const kind = caseOf(head, now);
    if (!kind) continue;
    const id = label(head.address);
    if (dbIds && !dbIds.has(id)) report.dbMisses.push(id);
    let seen = state.seen[id] && { ...state.seen[id] };
    if (kind === "finalize" && !seen && !(await deps.committed(head))) continue;
    seen ??= { since: now };
    next.seen[id] = seen;

    const ageSecs = now - seen.since;
    const ready = kind === "refund" || ageSecs >= GRACE_SECS;
    const candidate: Candidate = { address: head.address, case: kind, ageSecs, action: ready ? "send" : "wait" };
    report.candidates.push(candidate);
    if (!ready) continue;

    const here = await deps.progress(head.address);
    if (here === null) {
      delete next.seen[id];
      report.candidates.pop();
      continue;
    }
    if (seen.triedAt !== here) {
      // It moved (or this is the first attempt): earlier tries and errors belong to another place.
      seen.triedAt = here;
      seen.tries = 0;
      seen.errors = 0;
      seen.alerted = false;
    }
    if ((seen.tries ?? 0) >= TRIES_BEFORE_ALERT || (seen.errors ?? 0) >= ERRORS_BEFORE_ALERT) {
      candidate.action = "stuck";
      const why = (seen.tries ?? 0) >= TRIES_BEFORE_ALERT ? `${kind} was sent ${seen.tries} times and the Match is still at ${here}` : `${kind} failed ${seen.errors} sweeps in a row at ${here}`;
      report.alerts.push(seen.alerted ? `${id} is stuck` : `${id} is stuck: ${why}`);
      if (!seen.alerted) {
        if (!dryRun) seen.alerted = true;
        report.newAlerts.push(`${id} is stuck: ${why}`);
      }
      if (now - (seen.lastTryAt ?? 0) < RETRY_ALERTED_SECS) continue;
    }
    if (dryRun) continue;
    seen.lastTryAt = now;
    try {
      if (kind === "refund") await deps.refund(head);
      else {
        if (kind === "finalize") await deps.finalize(head);
        await deps.finish(head.address);
      }
      seen.tries = (seen.tries ?? 0) + 1;
      seen.errors = 0;
    } catch (e) {
      if (e instanceof Deferred) {
        log("sweep", id, `wait: ${kind} deferred, ${e.message}`);
        continue;
      }
      seen.errors = (seen.errors ?? 0) + 1;
      log("sweep", id, `ERROR ${kind}: ${String((e as Error).message ?? e).split("\n")[0].slice(0, 200)}`);
    }
    if ((await deps.progress(head.address)) === null) delete next.seen[id];
  }

  if (!dryRun) store.save(next);
  return report;
}
