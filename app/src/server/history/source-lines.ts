import { PublicKey } from "@solana/web3.js";
import type { MatchKey } from "./match-key";
import type { Rpc } from "./rpc";

type Payload = Record<string, any>;
export interface SourceLineEvidence { header: Payload | null; settled: Payload | null; won?: Payload | null; records: Payload[] }
const exact = (v: unknown): bigint => {
  if (typeof v === "number" && !Number.isSafeInteger(v)) throw new Error("non-lossless legacy quantity");
  if (!/^-?\d+$/.test(String(v))) throw new Error("invalid exact quantity");
  return BigInt(String(v));
};
const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Raw historical snapshot, not the merged recipient line or its current Redeem-now amount. */
export function sourceLine(raw: string) {
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 144 || bytes.toString("base64") !== raw) throw new Error("invalid Line snapshot");
  return { raw, source: new PublicKey(bytes.subarray(11, 43)).toBase58(), amount: bytes.readBigUInt64LE(43).toString() };
}

/** Reconstruct by numeric durable step, never arrival order. Old or partial streams remain explicitly incomplete. */
export function reconcileSourceLines(evidence: SourceLineEvidence) {
  const reasons: string[] = [];
  const originals = new Map<string, { potSide: number; potIndex: number; raw: string; source: string; amount: string }>();
  const remaining = new Map<string, bigint>();
  const credits: { step: number; purpose: number; recipientKind: number; recipient: string; placement: number; raw: string; source: string; amount: string }[] = [];
  try {
    const manifests = evidence.records.filter((r) => r.type === "lines-start");
    const progress = evidence.records.filter((r) => r.type === "lines-progress");
    const steps = evidence.records.filter((r) => r.type === "line-step").sort((a, b) => a.step - b.step);
    if (evidence.records.some((r) => r.version !== 1 || r.finalized !== true)) throw new Error("unsupported or unfinalized stream");
    if (manifests.length !== 1) throw new Error("missing unique manifest (legacy or incomplete stream)");
    const counts = manifests[0].pot_lines as number[];
    if (!Array.isArray(counts) || counts.length !== 2 || counts.some((n) => !integer(n))) throw new Error("invalid manifest counts");
    const final = progress.filter((p) => p.done).sort((a, b) => b.chunk_no - a.chunk_no)[0];
    if (!final || !evidence.settled || !evidence.header) throw new Error("missing header or final completion");
    if (![0, 1, 2, 3, 4, 5, 6].includes(evidence.header.kind) || evidence.header.kind !== evidence.settled.kind) throw new Error("lifecycle kind mismatch");
    if (evidence.header.kind === 0 && !evidence.won) throw new Error("missing win/Points record");
    if (evidence.header.finalized !== true || evidence.settled.finalized !== true || !manifests[0].signature || !final.signature
      || evidence.header.signature !== manifests[0].signature || evidence.settled.signature !== final.signature
      || (evidence.header.kind === 0 && (evidence.won?.finalized !== true || evidence.won.signature !== evidence.header.signature))) throw new Error("unbound or unfinalized header/completion");
    if (!integer(final.cumulative_steps) || !integer(final.chunk_no) || final.chunk_no !== evidence.settled.chunks) throw new Error("completion boundary mismatch");
    if (steps.length !== final.cumulative_steps) throw new Error("missing Source-line steps");
    let previous = 0, previousChunk = 0;
    for (const boundary of progress.sort((a, b) => a.chunk_no - b.chunk_no)) {
      if (!integer(boundary.chunk_no) || boundary.chunk_no !== previousChunk + 1 || boundary.chunk_no > final.chunk_no
        || !integer(boundary.cumulative_steps) || boundary.cumulative_steps <= previous
        || steps.slice(previous, boundary.cumulative_steps).length !== boundary.cumulative_steps - previous
        || steps.slice(previous, boundary.cumulative_steps).some((s) => s.chunk_no !== boundary.chunk_no)
        || boundary.done !== (boundary.chunk_no === final.chunk_no)) throw new Error("invalid progress boundary");
      previous = boundary.cumulative_steps;
      previousChunk = boundary.chunk_no;
    }
    for (const [index, step] of steps.entries()) {
      if (step.step !== index + 1 || !integer(step.chunk_no) || step.chunk_no < 1 || step.chunk_no > final.chunk_no) throw new Error("non-contiguous Source-line steps");
      if (![0, 1].includes(step.pot_side) || !integer(step.pot_index) || step.pot_index >= counts[step.pot_side]) throw new Error("step outside manifest");
      if (![0, 1, 2, 3, 4].includes(step.purpose) || ![0, 1].includes(step.recipient_kind) || ![0, 1, 2, 3, 255].includes(step.placement)) throw new Error("invalid credit destination");
      const input = sourceLine(step.incoming), output = sourceLine(step.outgoing);
      if (input.source !== output.source || exact(output.amount) > exact(input.amount) || exact(output.amount) <= 0n) throw new Error("invalid credit quantity or Source");
      const slot = `${step.pot_side}:${step.pot_index}`;
      const header = evidence.header;
      const manifest = manifests[0];
      const funder = step.pot_side === 0 ? header.a_funder : header.b_funder;
      const inBytes = Buffer.from(step.incoming, "base64"), outBytes = Buffer.from(step.outgoing, "base64");
      if (step.purpose === 3) {
        if (step.recipient !== funder || step.recipient_kind !== 0 || step.placement > 2 || step.incoming !== step.outgoing
          || (header.kind === 0 && step.pot_side !== header.winner_side)) throw new Error("invalid original-line return");
      } else if (step.purpose === 4) {
        const winningParty = header.winner_side === 0 ? [header.a_player, header.a_funder] : [header.b_player, header.b_funder];
        if (header.kind !== 0 || step.pot_side === header.winner_side || step.recipient_kind !== 0 || step.placement > 2
          || !winningParty.includes(step.recipient) || outBytes[0] !== 1 || outBytes[1] !== inBytes[1]) throw new Error("invalid surplus route");
      } else {
        if (!([0, 1].includes(header.kind)) || (header.kind === 1 && step.purpose !== 0)
          || (header.kind === 0 && step.pot_side === header.winner_side)) throw new Error("invalid fee origin");
        const outside = step.purpose === 1 && manifest.studio_owner;
        const priority = step.purpose !== 1 || manifest.studio_priority;
        if (priority) {
          if (outBytes[0] !== 0 || outBytes[1] !== step.purpose || step.recipient_kind !== (outside ? 0 : 1)
            || step.recipient !== (outside || input.source) || step.placement !== (outside ? 255 : 3)) throw new Error("invalid priority fee route");
        } else if (!outside || step.recipient_kind !== 0 || step.recipient !== outside || step.placement > 2
          || outBytes[0] !== 1 || outBytes[1] !== inBytes[1]) throw new Error("invalid ordinary Studio fee route");
      }
      if (!originals.has(slot)) originals.set(slot, { potSide: step.pot_side, potIndex: step.pot_index, ...input });
      if (exact(input.amount) !== (remaining.get(slot) ?? exact(originals.get(slot)!.amount))
        || input.source !== originals.get(slot)!.source) throw new Error("Pot slot credit chain mismatch");
      remaining.set(slot, exact(input.amount) - exact(output.amount));
      credits.push({ step: step.step, purpose: step.purpose, recipientKind: step.recipient_kind, recipient: step.recipient, placement: step.placement, ...output });
    }
    if (originals.size !== counts[0] + counts[1]) throw new Error("missing original Pot slots");
    if ([...remaining.values()].some((amount) => amount !== 0n)) throw new Error("unpaid original Pot line");
    const header = evidence.header;
    const entry = exact(header.entry_exact ?? header.entry);
    const fees = (header.fees_exact ?? header.fees).map(exact) as bigint[];
    if (header.kind === 0) {
      const won = evidence.won!;
      if (![0, 1].includes(header.winner_side) || won.game !== header.game || exact(won.entry_exact ?? won.entry) !== entry
        || exact(won.pool_fee_exact ?? won.pool_fee) !== fees[2] || won.winner !== (header.winner_side === 0 ? header.a_player : header.b_player)
        || won.loser !== (header.winner_side === 0 ? header.b_player : header.a_player)) throw new Error("win/Points record mismatch");
    }
    const incoming = [0n, 0n];
    for (const line of originals.values()) incoming[line.potSide] += exact(line.amount);
    if (incoming[0] !== entry || incoming[1] !== (header.b_player ? entry : 0n)) throw new Error("entry conservation mismatch");
    const paidFees = [0n, 0n, 0n];
    const payouts = new Map<string, bigint>();
    let outgoing = 0n;
    for (const credit of credits) {
      const amount = exact(credit.amount);
      outgoing += amount;
      if (credit.purpose < 3) paidFees[credit.purpose] += amount;
      else {
        if (credit.recipientKind !== 0) throw new Error("party payout addressed to counter");
        payouts.set(credit.recipient, (payouts.get(credit.recipient) ?? 0n) + amount);
      }
    }
    if (outgoing !== incoming[0] + incoming[1] || paidFees.some((n, i) => n !== fees[i])) throw new Error("credit or fee conservation mismatch");
    const expected = new Map<string, bigint>();
    for (const funder of [header.a_funder, ...(header.b_player ? [header.b_funder] : [])]) expected.set(funder, (expected.get(funder) ?? 0n) + entry);
    for (const party of header.parties) expected.set(party.account, (expected.get(party.account) ?? 0n) + exact(party.delta_exact ?? party.delta));
    for (const account of new Set([...expected.keys(), ...payouts.keys()])) {
      if ((expected.get(account) ?? 0n) !== (payouts.get(account) ?? 0n)) throw new Error("party payout mismatch");
    }
  } catch (error) { reasons.push((error as Error).message); }
  return { complete: reasons.length === 0, reasons, originals: [...originals.values()], credits };
}

export async function settlementSourceLines(rpc: Rpc, id: MatchKey) {
  const evidence = await rpc("match_source_line_events", { p_opener: id.opener, p_n: id.n.toString() }) as SourceLineEvidence;
  return { ...reconcileSourceLines(evidence), evidence };
}
