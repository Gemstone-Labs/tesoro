/**
 * Spike for Vanguard ticket 01: can a Player's move reach the private rollup (devnet TEE) inside a 5-second turn?
 *
 * Stand-in: a Trading Duel Match (an existing delegated Game). A "turn" starts when a `tick` changes
 * `duel.lastTick` (the rollup's whole-second clock, seen over the account subscription). The mover then waits
 * 4.5 s "on screen" and sends a `set_pick` (a signed rollup write, sent exactly like the app's `sendTee`).
 * A peer process on another machine sends a `claim_timeout` (refused on a live Duel, but ordered like any
 * transaction) aimed at the first moment it would be valid: the rollup clock reaching start + 5 s + grace + 1 s.
 *
 * One process plays both roles at once: mover in its own Matches, claimer in the peer's. Run one on the laptop
 * and one on the VPS (see the ticket's report for the commands). Output: a JSONL file; `turn-latency-report.ts`
 * turns the two files into the numbers.
 *
 *   tsx scripts/turn-latency-spike.ts --label laptop --keys qeF,qeE --my-base 1792350000000 --peer-base 1792360000000 --matches 14
 *
 * Matches are Challenges (odd ids) opened with the QA dev keys, played with picks no price can reach, so both
 * sides score 0 and the Match is a draw: both entries are refunded.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY, Transaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { BlockPuzzleChain, keypairSigner as bpSigner } from "../../app/src/games/block-puzzle/chain.ts";
import { keypairSigner } from "../../app/src/games/holdem/chain.ts";
import {
  STATUS,
  TRADING_DUEL_PROGRAM_ID,
  TradingDuelChain,
  addresses,
  assetOfMatchId,
  decodeBook,
  decodeDuel,
  duelMatchId,
  type Addresses,
  type Duel,
} from "../../app/src/games/trading-duel/chain.ts";
import { loadIdl, newConnection } from "../src/runtime.ts";
import { boundaryOffsetMs, percentile } from "../src/turn-stats.ts";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
};
const LABEL = arg("label");
const KEYS = arg("keys").split(",");
const GAP_MS = Number(arg("gap-ms", "560000"));
const PING_EVERY_MS = Number(arg("ping-ms", "1500"));
const MY_BASE = Number(arg("my-base"));
const PEER_BASE = Number(arg("peer-base"));
const MATCHES = Number(arg("matches", "14"));
const GRID_MS = Number(arg("grid-ms", "8000"));
const ENTRY = 500;
const MOVE_AFTER_MS = Number(arg("move-after-ms", "4500"));
const TURN_SECS = 5;
const GRACE_SECS = 1;
const LAST_TRIAL_T = 118;
const OUT = arg("out", `${process.env.TMPDIR ?? "."}/turn-latency-${LABEL}.jsonl`);
const BASE_RPC = process.env.SPIKE_BASE_RPC ?? "https://rpc.magicblock.app/devnet";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const record = (o: Record<string, unknown>) => appendFileSync(OUT, JSON.stringify({ label: LABEL, at: Date.now(), ...o }) + "\n");
const say = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 23), ...a);

const devKeys = JSON.parse(readFileSync(`${homedir()}/.cache/tesoro-tmp/qa/devkeys.json`, "utf8"));
const kp = (name: string) => Keypair.fromSecretKey(utils.bytes.bs58.decode(devKeys[name].sol));
const [KP_A, KP_B] = [kp(KEYS[0]), kp(KEYS[1])];

const base = newConnection(BASE_RPC);
const coreIdl = loadIdl("tesoro_core");
const bp = new BlockPuzzleChain({ base, blockPuzzleIdl: loadIdl("block_puzzle"), coreIdl });
const td = new TradingDuelChain(loadIdl("trading_duel"), coreIdl, { base });
const [bpA, bpB] = [bpSigner(KP_A), bpSigner(KP_B)];
const [sgA, sgB] = [keypairSigner(KP_A), keypairSigner(KP_B)];

// -- the rollup clock ----------------------------------------------------------------------------

interface ClockReading {
  ts: number;
  slot: number;
  seenMs: number;
  rttMs: number;
}
const clock = { readings: [] as ClockReading[], boundaryMs: 0, oneWayMs: 50 };

/** Reads the rollup's Clock sysvar in a loop (one request at a time); keeps the boundary offset and one-way delay fresh. */
async function clockProbe(conn: Connection, stop: () => boolean) {
  let lastTs = 0;
  let windowStart = Date.now();
  let steps: number[] = [];
  let changes = 0;
  let n = 0;
  while (!stop()) {
    const a = Date.now();
    const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY).catch(() => null);
    const b = Date.now();
    if (info) {
      const ts = Number(info.data.readBigInt64LE(32));
      const r = { ts, slot: Number(info.data.readBigUInt64LE(0)), seenMs: (a + b) / 2, rttMs: b - a };
      n++;
      if (lastTs && ts !== lastTs) {
        changes++;
        steps.push(ts - lastTs);
      }
      lastTs = ts;
      clock.readings.push(r);
      if (clock.readings.length > 400) clock.readings.shift();
      clock.boundaryMs = boundaryOffsetMs(clock.readings);
      clock.oneWayMs = percentile(clock.readings.map((x) => x.rttMs), 50) / 2;
    }
    if (Date.now() - windowStart >= 60_000) {
      record({ type: "clock", boundaryMs: clock.boundaryMs, oneWayMs: clock.oneWayMs, readings: n, changes, steps: [...new Set(steps)] });
      windowStart = Date.now();
      n = 0;
      changes = 0;
      steps = [];
    }
    await sleep(40);
  }
}

// -- rollup sends, timed like the app's sendTee ---------------------------------------------------

interface Marks {
  start: number;
  hash: number;
  signed: number;
  send0: number;
  sent: number;
  poll: number;
}
async function timedSend(conn: Connection, kpr: Keypair, ixs: TransactionInstruction[]): Promise<{ sig: string; marks: Marks; err?: unknown }> {
  const start = Date.now();
  const tx = new Transaction().add(...ixs);
  tx.feePayer = kpr.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const hash = Date.now();
  tx.partialSign(kpr);
  const signed = Date.now();
  const raw = tx.serialize();
  const send0 = Date.now();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: true });
  const sent = Date.now();
  const marks = { start, hash, signed, send0, sent, poll: 0 };
  for (let i = 0; i < 60; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st) {
      marks.poll = Date.now();
      return { sig, marks, err: st.err ?? undefined };
    }
    await sleep(400);
  }
  return { sig, marks, err: "not confirmed" };
}

/** Slot, whole-second block time and position inside the block of a rollup transaction. */
async function whereLanded(conn: Connection, sig: string) {
  for (let i = 0; i < 5; i++) {
    const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    if (t) {
      let index: number | null = null;
      const block = await (conn as any).getBlock(t.slot, { transactionDetails: "signatures", maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (block?.signatures) index = block.signatures.indexOf(sig);
      return { slot: t.slot, blockTime: t.blockTime, index, failed: !!t.meta?.err };
    }
    await sleep(700);
  }
  return null;
}

// -- one Match -------------------------------------------------------------------------------------

async function ownHolding(kpr: Keypair): Promise<PublicKey> {
  const acct = BlockPuzzleChain.coreAccount(kpr.publicKey);
  const hs: any[] = await td.tesoro.account.holdingState.all([{ memcmp: { offset: 9, bytes: acct.toBase58() } }]);
  const h = hs.find((x) => x.account.inner.isOwn && BigInt(x.account.inner.amount.toString()) - BigInt(x.account.inner.reserved.toString()) >= BigInt(ENTRY));
  if (!h) throw new Error(`${kpr.publicKey.toBase58()} has no own Gemas for an entry of ${ENTRY}`);
  return h.publicKey as PublicKey;
}

/** Opens, joins, creates and delegates the Duel. Returns once it is waiting in the rollup, not started. */
async function prepare(id: bigint): Promise<string[]> {
  const sigs: string[] = [];
  sigs.push(await bp.openMatch(bpA, id, ENTRY, [await ownHolding(KP_A)], TRADING_DUEL_PROGRAM_ID));
  sigs.push(await bp.joinMatch(bpB, id, [await ownHolding(KP_B)], TRADING_DUEL_PROGRAM_ID));
  sigs.push(await td.createDuel(sgB, id, KP_A.publicKey, KP_B.publicKey));
  await td.delegateDuel(sgB, id);
  return sigs;
}

async function finish(id: bigint, sigs: string[]) {
  const deadline = Date.now() + 6 * 60_000;
  const state = async () => {
    const m = await td.readTesoroMatch(id);
    return m ? Object.keys(m.inner.status)[0] : "gone";
  };
  while (Date.now() < deadline) {
    const st = await state();
    if (st === "settled" || st === "refunded") {
      record({ type: "settled", id: id.toString(), status: st, sigs });
      say("match", id.toString(), st);
      return;
    }
    try {
      const d = await td.readDuel(sgB, id);
      if (d && d.status === STATUS.live && Date.now() / 1000 + clock.boundaryMs / 1000 > d.endsAt) sigs.push(await td.end(sgB, id));
      else if (d && (d.status === STATUS.over || d.status === STATUS.cancelled)) sigs.push((await td.closeMatch(sgB, id)).tee);
      else if (!d) sigs.push(await td.finalize(sgB, id));
    } catch (e: any) {
      say("finish step", String(e?.message ?? e).slice(0, 120));
    }
    await sleep(2500);
  }
  record({ type: "unsettled", id: id.toString(), status: await state(), sigs });
  say("UNSETTLED", id.toString());
}

/** Plays the mover's side of one started Duel: timed turns on the wall-clock grid. */
async function runTrials(id: bigint, k: number) {
  const ad = addresses(id);
  const asset = assetOfMatchId(id)!;
  const conn = await td.teeConnection(sgB);
  let duel = (await td.readDuel(sgB, id))!;
  const waiters: ((d: Duel) => void)[] = [];
  let duelAt = 0;
  const sub1 = conn.onAccountChange(ad.duel, (i) => {
    duel = decodeDuel(ad.duel, td.program.coder.accounts.decode("duel", i.data.slice(0, i.data.length)));
    duelAt = Date.now();
    waiters.splice(0).forEach((w) => w(duel));
  }, "confirmed");
  const bookWaiters = new Map<number, (at: number) => void>();
  const sub2 = conn.onAccountChange(ad.book1, (i) => {
    const at = Date.now();
    const b = decodeBook(ad.book1, td.program.coder.accounts.decode("book", i.data));
    for (const [band, w] of bookWaiters) if (b.picks.includes(band)) (bookWaiters.delete(band), w(at));
  }, "confirmed");
  const next = <T>(list: ((v: T) => void)[], ms: number) =>
    new Promise<T | null>((res) => {
      const t = setTimeout(() => res(null), ms);
      list.push((v) => (clearTimeout(t), res(v)));
    });

  const bookSeenAt = (band: number) =>
    new Promise<number | null>((res) => {
      const t = setTimeout(() => (bookWaiters.delete(band), res(null)), 8000);
      bookWaiters.set(band, (at) => (clearTimeout(t), res(at)));
    });
  const inWindow = () => duel.status === STATUS.live && (Date.now() + clock.boundaryMs) / 1000 - duel.startsAt <= LAST_TRIAL_T;
  // Plain sends on top of the turns: more samples of send -> account update, at jittered spacing.
  let pinging = true;
  let pingBand = 20_000 + k * 1000;
  const pings = (async () => {
    while (pinging) {
      await sleep(PING_EVERY_MS * (0.5 + Math.random()));
      if (!pinging || !inWindow()) continue;
      const band = pingBand++;
      const seen = bookSeenAt(band);
      const ix = await td.program.methods.setPick(10, band).accountsPartial({ player: KP_B.publicKey, duel: ad.duel, book: ad.book1 } as any).instruction();
      const r = await timedSend(conn, KP_B, [ix]).catch((e) => ({ sig: "", marks: null, err: String(e) }));
      record({ type: "ping", match: id.toString(), sig: r.sig, err: r.err, marks: r.marks, subAt: await seen });
    }
  })();

  let seq = 0;
  for (;;) {
    const grid = Math.ceil((Date.now() + 100) / GRID_MS) * GRID_MS;
    await sleep(grid - Date.now());
    if (!inWindow()) break;
    const prev = duel.lastTick;
    const tick = await timedSend(conn, KP_B, [
      await td.program.methods.tick().accountsPartial({ caller: KP_B.publicKey, duel: ad.duel, book0: ad.book0, book1: ad.book1, priceFeed: asset.feed } as any).instruction(),
    ]);
    const seen = duel.lastTick !== prev ? { lastTick: duel.lastTick, at: duelAt } : await next<Duel>(waiters, 2500).then((d) => (d && d.lastTick !== prev ? { lastTick: d.lastTick, at: duelAt } : null));
    if (!seen) {
      record({ type: "turn-failed", match: id.toString(), k: seq, tickSig: tick.sig, err: tick.err ?? "no lastTick change" });
      continue;
    }
    // The turn starts on screen now; the Player moves 4.5 s later.
    await sleep(Math.max(0, seen.at + MOVE_AFTER_MS - Date.now()));
    const band = 1000 + (k * 40 + seq);
    const bookSeen = bookSeenAt(band);
    const ix = await td.program.methods.setPick(11, band).accountsPartial({ player: KP_B.publicKey, duel: ad.duel, book: ad.book1 } as any).instruction();
    const move = await timedSend(conn, KP_B, [ix]);
    const subAt = await bookSeen;
    record({
      type: "move",
      match: id.toString(),
      k: seq,
      turnTs: seen.lastTick,
      turnSeenMs: seen.at,
      tickSig: tick.sig,
      sig: move.sig,
      err: move.err,
      marks: move.marks,
      subAt,
      boundaryMs: clock.boundaryMs,
    });
    void whereLanded(conn, move.sig).then((w) => record({ type: "landed", sig: move.sig, role: "move", ...w }));
    void whereLanded(conn, tick.sig).then((w) => record({ type: "landed", sig: tick.sig, role: "tick", ...w }));
    seq++;
  }
  pinging = false;
  await pings;
  await conn.removeAccountChangeListener(sub1);
  await conn.removeAccountChangeListener(sub2);
}

/** The peer's Match: watch its Duel and fire a stand-in `claim_timeout` at the first moment it would be valid. */
async function claimer(k: number, stopAll: () => boolean) {
  const id = duelMatchId(0, true, PEER_BASE + k);
  const ad: Addresses = addresses(id);
  const conn = await td.teeConnection(sgA);
  say("claimer waiting for peer match", k);
  const give = Date.now() + 20 * 60_000;
  for (;;) {
    if (stopAll() || Date.now() > give) return;
    const info = await conn.getAccountInfo(ad.duel).catch(() => null);
    if (info && decodeDuel(ad.duel, td.program.coder.accounts.decode("duel", info.data)).status === STATUS.live) break;
    await sleep(1000);
  }
  let last = 0;
  let over = false;
  const ixP = td.program.methods.claimTimeout().accountsPartial({ caller: KP_A.publicKey, duel: ad.duel }).instruction();
  const sub = conn.onAccountChange(ad.duel, (i) => {
    const d = decodeDuel(ad.duel, td.program.coder.accounts.decode("duel", i.data));
    const nowMs = Date.now();
    if (d.status !== STATUS.live) over = true;
    if (d.lastTick === last) return;
    last = d.lastTick;
    const gridStart = Math.floor((nowMs - 100) / GRID_MS) * GRID_MS;
    if (nowMs - gridStart > 2600) return;
    const targetLocal = clock.boundaryMs + (d.lastTick + TURN_SECS + GRACE_SECS + 1) * 1000 - clock.oneWayMs;
    void (async () => {
      await sleep(Math.max(0, targetLocal - Date.now() - 30));
      const ix = await ixP;
      const r = await timedSend(conn, KP_A, [ix]);
      record({ type: "claim", match: id.toString(), turnTs: d.lastTick, targetLocal, sig: r.sig, marks: r.marks, err: r.err, boundaryMs: clock.boundaryMs });
      const w = await whereLanded(conn, r.sig);
      record({ type: "landed", sig: r.sig, role: "claim", ...w });
    })();
  }, "confirmed");
  while (!over && !stopAll()) await sleep(1000);
  await conn.removeAccountChangeListener(sub);
}

// -- main ---------------------------------------------------------------------------------------------

async function main() {
  record({ type: "start", keys: KEYS, myBase: MY_BASE, peerBase: PEER_BASE, matches: MATCHES, gridMs: GRID_MS, node: process.version });
  const teeA = await td.teeConnection(sgA);
  let done = false;
  const probe = clockProbe(teeA, () => done);
  // The peer's Matches: one claimer after another.
  const claims = (async () => {
    for (let k = 0; k < MATCHES && !done; k++) await claimer(k, () => done);
  })();
  const settle: Promise<void>[] = [];
  let ready: Promise<string[]> | null = null;
  const idOf = (k: number) => duelMatchId(0, true, MY_BASE + k);
  const t0 = Date.now();
  ready = prepare(idOf(0));
  for (let k = 0; k < MATCHES; k++) {
    const id = idOf(k);
    const sigs = await ready;
    await sleep(t0 + k * GAP_MS - Date.now());
    // Start, then set the next Match up while this one runs.
    let d = await td.readDuel(sgB, id);
    for (let i = 0; i < 20 && !d; i++) (await sleep(500), (d = await td.readDuel(sgB, id)));
    sigs.push(await td.start(sgB, id, assetOfMatchId(id)!));
    const lamports = await Promise.all([base.getBalance(KP_A.publicKey), base.getBalance(KP_B.publicKey)]);
    say("match", k, id.toString(), "started; SOL left", lamports.map((l) => l / 1e9).join(" / "));
    record({ type: "match", k, id: id.toString() });
    ready = k + 1 < MATCHES ? sleep(Math.max(0, t0 + (k + 1) * GAP_MS - 45_000 - Date.now())).then(() => prepare(idOf(k + 1))) : Promise.resolve([]);
    await runTrials(id, k);
    settle.push(finish(id, sigs));
  }
  await Promise.all(settle);
  done = true;
  await Promise.race([Promise.all([probe, claims]), sleep(5000)]);
  record({ type: "end" });
}

main().then(
  () => process.exit(0),
  (e) => {
    say("FATAL", e);
    record({ type: "fatal", error: String(e?.stack ?? e).slice(0, 600) });
    process.exit(1);
  },
);
