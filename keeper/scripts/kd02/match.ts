// kd-02 match measurements from real devnet Matches: the instructions of past Block Burst Matches are re-assembled into the
// candidate bundles, so account lists and CU are real (the Match state they ran on is already settled, so they are not re-run).
//   KD_MATCHES=8 tsx scripts/kd02/match.ts
import { PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { QA, conn, fakeAlt, fetchParsed, legacyBytes, loadAlt, retry, saveReports, shapeOf, simV0, toReport, type BundleReport, type Parsed } from "./lib.ts";

const BURST = new PublicKey("5WVV5k7ZrLP4LQ6mTpToLppF41cq2kasmW2bTnXVo7dj");
const SPONSOR_ALT = new PublicKey("HcQqickLYCgnPkkmWZgHFjq5sThNeow19WnLZDwKF3KZ");
const N = Number(process.env.KD_MATCHES ?? 8);
const sponsorAlt = await loadAlt(SPONSOR_ALT);

// 1. recent AssignMatch transactions -> their Match accounts (key index 2 of the Assign instruction)
const sigs = await retry(() => conn.getSignaturesForAddress(BURST, { limit: 300 }, "confirmed"));
const matches = new Map<string, string>();
for (const s of sigs) {
  if (s.err || matches.size >= N) continue;
  const p = await fetchParsed(s.signature);
  if (!p || !p.names.includes("AssignMatch")) continue;
  const ix = p.ixs.find((i) => i.programId.equals(BURST) && i.keys.length >= 3)!;
  matches.set(ix.keys[2].pubkey.toBase58(), s.signature);
}
console.log(`# ${matches.size} Block Burst Matches with an assignment`);

interface Life {
  match: string;
  join?: Parsed;
  assign?: Parsed;
  finalize?: Parsed;
  chunks: Parsed[];
  close?: Parsed;
}
const lives: Life[] = [];
for (const m of matches.keys()) {
  const ss = await retry(() => conn.getSignaturesForAddress(new PublicKey(m), { limit: 60 }, "confirmed"));
  const life: Life = { match: m, chunks: [] };
  for (const s of ss.reverse()) {
    if (s.err) continue;
    const p = await fetchParsed(s.signature);
    if (!p) continue;
    if (p.names.includes("JoinMatch") && !life.join) life.join = p;
    else if (p.names.includes("AssignMatch")) life.assign = p;
    else if (p.names.includes("Finalize")) life.finalize = p;
    else if (p.names.includes("MatchChunk")) life.chunks.push(p);
    else if (p.names.includes("CloseMatch")) life.close = p;
  }
  lives.push(life);
}

const line = (p: Parsed | undefined) => (p ? { sig: p.sig, ver: p.version, static: p.staticKeys, loaded: p.loadedKeys, tables: p.tables.map((t) => t.toBase58()), cu: p.totalCu, names: p.names.join("+"), payer: p.feePayer.toBase58() } : null);
console.log("\n## per Match (real transactions)");
for (const l of lives) console.log(JSON.stringify({ match: l.match, join: line(l.join), assign: line(l.assign), finalize: line(l.finalize), chunks: l.chunks.map((c) => ({ sig: c.sig, static: c.staticKeys, loaded: c.loadedKeys, cu: c.totalCu })), close: line(l.close) }));

async function bundle(name: string, parts: (Parsed | undefined)[], reports: BundleReport[]) {
  const ps = parts.filter(Boolean) as Parsed[];
  if (ps.length !== parts.length) return;
  const ixs: TransactionInstruction[] = ps.flatMap((p) => p.ixs);
  const payer = ps[0].feePayer;
  const shape = shapeOf(payer, ixs);
  const bare = await simV0(payer, ixs, [], false);
  const ideal = await simV0(payer, ixs, [fakeAlt(shape.lookupable)], false);
  const withSponsor = await simV0(payer, ixs, [sponsorAlt], false);
  const used = shape.lookupable.filter((k) => sponsorAlt.state.addresses.some((a) => a.equals(k))).length;
  console.log(JSON.stringify({ bundle: name, match: ps.map((p) => p.sig.slice(0, 8)), unique: shape.unique, signers: shape.signers.length, programs: shape.programs.length, lookupable: shape.lookupable.length, writable: shape.writable, cuSum: ps.reduce((a, p) => a + p.totalCu, 0), legacyBytes: legacyBytes(payer, ixs), v0NoAlt: bare.bytes, v0SponsorAlt: withSponsor.bytes, sponsorAltHits: used, v0IdealAlt: ideal.bytes }));
  reports.push(toReport(name, payer, ixs));
}

console.log("\n## bundles (re-assembled from real instructions)");
const reports: BundleReport[] = [];
for (const l of lives) {
  await bundle("join_match+assign_match", [l.join, l.assign], reports);
  await bundle("finalize+match_chunk#1", [l.finalize, l.chunks[0]], reports);
}
// 3. the single largest chunk and the instruction CU of every chunk, for the "first chunk" question
console.log("\n## match_chunk by size (real)");
for (const l of lives) for (const c of l.chunks) console.log(JSON.stringify({ match: l.match.slice(0, 6), chunk: c.sig.slice(0, 8), static: c.staticKeys, loaded: c.loadedKeys, cu: c.totalCu }));
saveReports(process.env.KD_OUT ?? "/tmp/kd02-match-bundles.json", reports);
