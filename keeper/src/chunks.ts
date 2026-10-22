import { PublicKey } from "@solana/web3.js";
import type { Store } from "./kit.ts";

/** One phase of a Settling or Refunding run, in the order the program walks them. */
export type Phase = { kind: "cuts" | "back"; side: number } | { kind: "surplus"; from: number; to: number };

export interface RunFacts {
  phases: Phase[];
  phaseI: number;
  lineI: number;
  /** Per side, the Gemas still to cut for Platform, Studio and Leaderboard. */
  cutLeft: bigint[][];
}

const num = (v: unknown) => Number((v as { toString(): string }).toString());
/** Anchor decodes tuple variants either as an array or as `{ "0": v }`. */
const first = (v: unknown): number => (Array.isArray(v) ? num(v[0]) : typeof v === "object" && v !== null ? num((v as Record<string, unknown>)["0"] ?? Object.values(v)[0]) : num(v));

/** The decoded `Phase` of the IDL (`{ cuts: [side] }`, `{ back: [side] }`, `{ surplus: { from, to } }`). */
export function phaseOf(raw: Record<string, unknown>): Phase {
  const [name, value] = Object.entries(raw)[0];
  const key = name.toLowerCase();
  if (key === "cuts" || key === "back") return { kind: key, side: first(value) };
  if (key === "surplus") {
    const v = value as { from: unknown; to: unknown };
    return { kind: "surplus", from: num(v.from), to: num(v.to) };
  }
  throw new Error(`unknown phase ${name}`);
}

/** The cursor of a decoded `Run`; null for a Match whose run has not started. */
export function runOf(run: any | null | undefined): RunFacts | null {
  if (!run) return null;
  const n = num(run.nPhases ?? run.n_phases);
  const phases = (run.phases as Record<string, unknown>[]).slice(0, n).map(phaseOf);
  return {
    phases,
    phaseI: num(run.phaseI ?? run.phase_i),
    lineI: num(run.lineI ?? run.line_i),
    cutLeft: (run.cutLeft ?? run.cut_left).map((side: unknown[]) => side.map((v) => BigInt((v as { toString(): string }).toString()))),
  };
}

export interface Ahead {
  source: PublicKey;
  /** A fee is cut from this Source: its SourceState, Position and rate account are needed too. */
  cut: boolean;
}

/**
 * The Sources the next `maxLines` steps touch. A port of `MatchRecord::sources_ahead`
 * (programs/tesoro_core/src/ledger/lifecycle/mod.rs): it walks the same cursor the chunk walks.
 */
export function sourcesAhead(run: RunFacts, pots: (Store | null)[], maxLines: number): Ahead[] {
  const out: Ahead[] = [];
  let left = maxLines;
  const push = (source: PublicKey, cut: boolean) => {
    const seen = out.find((o) => o.source.equals(source));
    if (seen) seen.cut ||= cut;
    else out.push({ source, cut });
  };
  let lineI = run.lineI;
  const cutLeft = run.cutLeft.map((s) => [...s]);
  for (let pi = run.phaseI; pi < run.phases.length; pi++) {
    if (left === 0) break;
    const phase = run.phases[pi];
    if (phase.kind === "cuts") {
      const p = pots[phase.side];
      if (!p) continue;
      let avail: bigint | null = null;
      const needs = cutLeft[phase.side];
      for (let k = 0; k < needs.length; k++) {
        while (needs[k] > 0n && left > 0) {
          if (lineI >= p.len) break;
          const l = p.lineAt(lineI);
          const a: bigint = avail ?? l.amount;
          if (a === 0n) {
            lineI++;
            avail = null;
            continue;
          }
          push(l.source, true);
          const take = a < needs[k] ? a : needs[k];
          needs[k] -= take;
          left--;
          if (a === take) {
            lineI++;
            avail = null;
          } else avail = a - take;
        }
      }
      if (needs.some((n) => n > 0n)) break;
      lineI = 0;
    } else {
      const s = phase.kind === "surplus" ? phase.from : phase.side;
      const p = pots[s];
      if (!p) continue;
      while (lineI < p.len && left > 0) {
        const l = p.lineAt(lineI);
        if (l.amount > 0n) {
          push(l.source, false);
          left--;
        }
        lineI++;
      }
      if (lineI < p.len) break;
      lineI = 0;
    }
  }
  return out;
}

/** Players, Backers and an outside Studio that a run credits: the Accounts whose baskets and spills a chunk needs. */
export function creditedAccounts(rec: { a: { player: unknown; funder: unknown }; b?: { player: unknown; funder: unknown } | null; terms: { studioOwner?: unknown; studio_owner?: unknown } }, keyOf: (v: any) => PublicKey): PublicKey[] {
  const keys: PublicKey[] = [keyOf(rec.a.player), keyOf(rec.a.funder)];
  if (rec.b) keys.push(keyOf(rec.b.player), keyOf(rec.b.funder));
  const studio = rec.terms.studioOwner ?? rec.terms.studio_owner;
  if (studio) keys.push(keyOf(studio));
  const out: PublicKey[] = [];
  for (const k of keys) if (!out.some((o) => o.equals(k))) out.push(k);
  return out;
}
