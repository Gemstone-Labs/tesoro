/**
 * Timing of real Block Burst Matches on devnet: join -> started and time's up -> result, as the chain and the app's own
 * driver (`BurstDriver`, the code the Match page runs) see them. Two tester wallets open and join in Node, each runs a
 * driver, one plays a greedy bot so the Match ends with a winner (the other plays two moves).
 *
 *   cd app && ../keeper/node_modules/.bin/tsx scripts/match-timing.mts [matches=1] [entry=100] [out=timings.json] [testers=block-puzzle-testers.json]
 *
 * Key files are read from ~/.config/tesoro/ and never printed. Reads of closed Matches go to the live app's history route.
 * Does not start a keeper: the one keeper on the VPS does the Games' operator steps. Writes one JSON row per Match.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import type { MatchRun } from "@/games/block-puzzle/BlockPuzzleGame";
import type { State } from "@/games/block-puzzle/engine";

const HISTORY_ORIGIN = process.env.HISTORY_ORIGIN ?? "https://www.playtesoro.com";
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: string | URL | Request, i?: RequestInit) => {
  if (typeof u === "string" && u.startsWith("/api/sponsor")) return Promise.resolve(new Response(JSON.stringify({ error: "off", code: "sponsor-paused" }), { status: 503 }));
  return realFetch(typeof u === "string" && u.startsWith("/") ? HISTORY_ORIGIN + u : u, i);
}) as typeof fetch;

const { getChain } = await import("@/lib/chain/client");
const { BlockBurstChain, keypairSigner, SLOTS_PER_SEC, PLAY_SECS, tableOf } = await import("@/games/block-puzzle/live-chain");
const { BlockPuzzleChain } = await import("@/games/block-puzzle/chain");
const { BurstDriver } = await import("@/games/block-puzzle/burst-driver");
const { openEntry, joinEntry } = await import("@/lib/chain/entry-flow");
const { fetchMatch } = await import("@/lib/chain/read");
const { matchAddressOf } = await import("@/lib/chain/match-id");
const engine = await import("@/games/block-puzzle/engine");
const blockPuzzleIdl = (await import("@/lib/chain/idl/block_puzzle.json", { with: { type: "json" } })).default;
const coreIdl = (await import("@/lib/chain/idl/tesoro_core.json", { with: { type: "json" } })).default;

const [countArg, entryArg, outArg, testersArg] = process.argv.slice(2);
const COUNT = Number(countArg ?? 1);
const ENTRY = Number(entryArg ?? 100);
const OUT = outArg ?? "timings.json";
const testers = (JSON.parse(readFileSync(join(homedir(), ".config/tesoro", testersArg ?? "block-puzzle-testers.json"), "utf8")) as number[][]).map((k) => Keypair.fromSecretKey(Uint8Array.from(k)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noToken = async () => null;
const base = getChain().base;
const newChain = () => new BlockBurstChain(blockPuzzleIdl as never, coreIdl, { base });

type Row = Record<string, number | string | null>;

/** A greedy bot: the first unused piece at the first cell where it fits, up to `limit` moves. */
function playBot(run: MatchRun, limit: number) {
  let st: State = run.resume ?? engine.newState(run.seed);
  let n = 0;
  const loop = async () => {
    while (!st.over && n < limit && run.remainingMs() > 0) {
      const base0 = engine.handBase(st);
      let mv: { piece: number; x: number; y: number } | null = null;
      for (let s = 0; s < engine.HAND && !mv; s++) {
        if ((st.used >> s) & 1) continue;
        const piece = engine.pieceAt(st.seed, base0 + s);
        for (let y = 0; y < engine.SIZE && !mv; y++) for (let x = 0; x < engine.SIZE && !mv; x++) if (engine.fitsAt(st, piece, x, y)) mv = { piece: base0 + s, x, y };
      }
      if (!mv) break;
      st = engine.apply(st, mv).state;
      n++;
      run.onMove(mv);
      await sleep(400);
    }
    run.onEnd({ score: st.score, moves: st.moves, reason: st.over ? "stuck" : "limit" });
  };
  void loop();
}

async function oneMatch(i: number): Promise<Row> {
  const [openerKp, joinerKp] = i % 2 === 0 ? [testers[0], testers[1]] : [testers[1], testers[0]];
  const opener = keypairSigner(openerKp);
  const joiner = keypairSigner(joinerKp);
  const row: Row = { i, entry: ENTRY, openedBy: openerKp.publicKey.toBase58().slice(0, 4) };
  const T0 = Date.now();
  const mark = (k: string) => {
    if (row[k] == null) row[k] = Date.now() - T0;
  };

  const { key } = await openEntry({ signer: opener as never, getToken: noToken, game: "block-puzzle", entry: ENTRY, challenge: false });
  mark("opened");
  row.key = key;
  const mk = matchAddressOf(key)!;
  console.log(`[${i}] opened ${key}`);

  // Both drivers run from now, as the two Match pages do.
  const finalizeSigs: string[] = [];
  const steps: { stage: string; at: number; read?: string }[][] = [[], []];
  const drivers = [opener, joiner].map((signer, n) => {
    const d = new BurstDriver({
      onTx: (label, layer, sig) => {
        if (layer === "base" && label === "finalize") finalizeSigs.push(sig);
      },
      onProposed: (stage) => {
        const mine = steps[n];
        if (mine.at(-1)?.stage !== stage) mine.push({ stage, at: Math.round((Date.now() - T0) / 100) / 10 });
      }, id: key, signer: signer as never, accountKey: BlockPuzzleChain.coreAccount(signer.publicKey).toBase58(), getToken: noToken, chain: newChain(), fetchMatch });
    let last = "";
    let botStarted = false;
    d.subscribe((v) => {
      const tag = n === 0 ? "A" : "B";
      if (v.stage !== last) {
        last = v.stage;
        mark(`${tag}_stage_${v.stage}`);
      }
      if (v.run && !botStarted) {
        botStarted = true;
        mark(`${tag}_run`);
        playBot(v.run, n === 0 ? 120 : 2);
      }
    });
    return d;
  });
  drivers[0].start();
  await sleep(2_000);

  const joinStart = Date.now();
  await joinEntry({ signer: joiner as never, getToken: noToken, game: "block-puzzle", entry: ENTRY, key });
  row.joinTx = Date.now() - joinStart;
  mark("join");
  console.log(`[${i}] joined in ${row.joinTx} ms`);
  drivers[1].start();

  // The observer: raw chain facts at ~400 ms.
  const obs = newChain();
  const viewer = keypairSigner(testers[0]);
  let a: Awaited<ReturnType<typeof obs.readAssignment>> = null;
  let startSlot = 0;
  let sawActive = false;
  for (let guard = 0; guard < 2_000; guard++) {
    await sleep(400);
    const tm = await obs.readTesoroMatch(mk).catch(() => undefined);
    if (tm === undefined) continue;
    if (tm) {
      const stage = Object.keys(tm.inner.stage)[0];
      if (stage === "active") sawActive = true;
      if (sawActive && stage !== "active") mark("core_" + stage);
    } else if (sawActive) {
      mark("core_closed");
      break;
    }
    if (!a) {
      a = await obs.readAssignment(mk).catch(() => null);
      if (a) mark("assigned");
    }
    if (a) {
      const t = await obs.readTable(viewer, a).catch(() => null);
      if (t && tableOf(a, t)) {
        if (t.phase >= 1) mark("t_begun");
        if (t.seatsOpen) mark("t_seated");
        if (t.checkedIn[0] || t.checkedIn[1]) mark("t_checkin_first");
        if (t.checkedIn[0] && t.checkedIn[1]) mark("t_checkin_both");
        if (t.seedReady) mark("t_seed");
        if (t.startSlot) {
          mark("t_started");
          startSlot = t.startSlot;
        }
        if (t.phase === 4) mark("t_closed");
        if (t.phase === 4 && !t.dirty) mark("t_committed_tee");
        if (startSlot) {
          const slot = await obs.currentSlot(viewer).catch(() => 0);
          if (slot >= startSlot) mark("play_begins");
          if (slot >= startSlot + PLAY_SECS * SLOTS_PER_SEC) mark("times_up");
        }
      }
      const bt = await obs.readTableOnBase(a).catch(() => null);
      if (bt && tableOf(a, bt) && bt.phase === 4 && !bt.dirty) mark("t_committed_base");
    }
    if (row["A_stage_settled"] != null && row["B_stage_settled"] != null && row["core_closed"] != null) break;
    if (row["core_refunded"] != null || row["core_settled"] != null) if (row["A_stage_settled"] != null && row["B_stage_settled"] != null) break;
    if (Date.now() - T0 > 12 * 60_000) {
      row.timedOut = 1;
      break;
    }
  }
  for (const d of drivers) d.stop();
  // Who paid each finalize the pages sent (the relayer when sponsored, else the Player's wallet; a lost race still lands once).
  const payers: string[] = [];
  for (const sig of finalizeSigs) {
    const tx = await base.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
    const keys = tx?.transaction.message.getAccountKeys();
    payers.push(keys ? `${keys.get(0)!.toBase58().slice(0, 4)} fee ${tx?.meta?.fee ?? "?"} lamports` : "unreadable");
  }
  row.finalizePayers = payers.join("; ") || "none sent by a page (keeper did it)";
  row.t0 = T0;
  if (process.env.TIMELINES) {
    // The stages each page's reads proposed, one per change: the shape of src/lib/chain/match-sequences/*.json (ticket 01's replay test).
    const winner = drivers[0].view.result?.result ?? "unknown";
    steps.forEach((s, n) =>
      writeFileSync(
        join(process.env.TIMELINES!, `won-${key.slice(0, 4)}-${key.split("-").pop()}-${n === 0 ? "A" : "B"}.json`),
        JSON.stringify({ source: "recorded", note: `Real devnet Block Burst Match ${key}, played by a bot (A plays, B makes two moves), page ${n === 0 ? "A (the opener)" : "B (the joiner)"}, result ${winner}. Proposed stages as BurstDriver derived them from its reads, one per change, seconds since the opener's page opened.`, game: "block-puzzle", steps: s }, null, 1),
      ),
    );
  }
  return row;
}

if (process.env.FUND) {
  // Gemas for the testers: simSOL from the faucet, locked for an Advance (the Starter-pack path of the Wallet page).
  const { getTestSimSol, openPositionWithAdvance } = await import("@/lib/chain/native-flow");
  for (const kp of testers) {
    const s = keypairSigner(kp);
    try {
      console.log("faucet", await getTestSimSol(s as never, noToken));
    } catch (e) {
      console.log("faucet skipped:", String((e as Error).message ?? e).slice(0, 120));
    }
    console.log("advance", (await openPositionWithAdvance(s as never, noToken, 10_000_000_000n, 3, 1n, (m) => console.log("  ", m))).signature);
  }
  process.exit(0);
}

const rows: Row[] = [];
for (let i = 0; i < COUNT; i++) {
  try {
    rows.push(await oneMatch(i));
  } catch (e) {
    console.log(`[${i}] FAILED ${String((e as Error).message ?? e).slice(0, 300)}`);
    rows.push({ i, error: String((e as Error).message ?? e).slice(0, 300) });
  }
  writeFileSync(OUT, JSON.stringify(rows, null, 1));
  console.log(JSON.stringify(rows[rows.length - 1]));
}
process.exit(0);
