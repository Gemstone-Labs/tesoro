/**
 * Plays one full short heads-up Match on Solana devnet + the MagicBlock devnet TEE, through the
 * same client the app uses (app/src/games/holdem/chain.ts). Records evidence to evidence.json.
 *
 *   NODE_PATH=$PWD/node_modules npx tsx play.ts            # new match
 *   NODE_PATH=$PWD/node_modules npx tsx play.ts resume     # continue state.json
 *   ... play.ts noshow   # a Player never shows: hand one is cancelled, both entries refunded
 *   ... play.ts idle     # a Player goes idle: auto-folds, then forfeits after three misses
 */
import * as anchor from "@coral-xyz/anchor";
import { gameAccounts, pairPda } from "../../../app/src/lib/chain/game-record";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import {
  HoldemChain,
  PHASE,
  STATUS,
  SPEED_TURBO,
  HOLDEM_PROGRAM_ID,
  TESORO_CORE_PROGRAM_ID,
  BASE_RPC,
  addresses,
  cardName,
  call,
  check,
  fold,
  keypairSigner,
  raise,
  tesoroAccountPda,
  tesoroConfigPda,
  tesoroHoldingPda,
  tesoroMatchPda,
  type PlayerSigner,
  type Table,
} from "../../../app/src/games/holdem/chain";

const HERE = __dirname;
const ROOT = path.join(HERE, "../../..");
const MODE = ["noshow", "idle"].includes(process.argv[2]) ? process.argv[2] : "full";
const EVIDENCE = path.join(HERE, MODE === "full" ? "evidence.json" : `evidence-${MODE}.json`);
const STATE = path.join(HERE, MODE === "full" ? "state.json" : `state-${MODE}.json`);
const KEYS = path.join(HERE, ".keys.json");
const holdemIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/holdem.json"), "utf8"));
const tesoroIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/tesoro_core.json"), "utf8"));

const readKey = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const deployer = readKey(path.join(os.homedir(), ".config/solana/dev-2026-10.json"));
const oracle = readKey(path.join(os.homedir(), ".config/tesoro/oracle.json"));
const load = (f: string, d: any) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const save = (f: string, v: any) => fs.writeFileSync(f, JSON.stringify(v, null, 2));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const resume = process.argv[2] === "resume";
const evidence: any = resume ? load(EVIDENCE, { txs: [], checks: [] }) : { txs: [], checks: [] };
const state: any = resume ? load(STATE, {}) : {};
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const keys = load(KEYS, null) ?? (() => {
  const k = { p0: Array.from(Keypair.generate().secretKey), p1: Array.from(Keypair.generate().secretKey) };
  save(KEYS, k);
  return k;
})();
const k0 = Keypair.fromSecretKey(Uint8Array.from(keys.p0));
const k1 = Keypair.fromSecretKey(Uint8Array.from(keys.p1));
const p0 = keypairSigner(k0);
const p1 = keypairSigner(k1);
const players: PlayerSigner[] = [p0, p1];
const outsider = keypairSigner(deployer);

const base = new Connection(process.env.BASE_RPC ?? BASE_RPC, "confirmed");
const chain = new HoldemChain(holdemIdl, tesoroIdl, {
  base,
  onTx: (step, layer, sig) => {
    evidence.txs.push({ step, layer, sig, link: layer === "base" ? explorer(sig) : undefined });
    save(EVIDENCE, evidence);
    console.log(`[${layer}] ${step}: ${sig}`);
  },
});
const tesoro = chain.tesoro;

function check_(name: string, pass: boolean, detail: unknown) {
  evidence.checks.push({ name, pass, detail });
  save(EVIDENCE, evidence);
  console.log(`${pass ? "PASS" : "FAIL"} ${name} :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

async function sendBase(step: string, ixs: anchor.web3.TransactionInstruction[], signers: Keypair[]) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  const latest = await base.getLatestBlockhash();
  tx.recentBlockhash = latest.blockhash;
  tx.sign(...signers);
  const sig = await base.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const res = await base.confirmTransaction({ signature: sig, ...latest }, "confirmed");
  if (res.value.err) {
    const t = await base.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    throw new Error(`${step} failed ${sig}: ${JSON.stringify(res.value.err)}\n${t?.meta?.logMessages?.join("\n")}`);
  }
  evidence.txs.push({ step, layer: "base", sig, link: explorer(sig) });
  save(EVIDENCE, evidence);
  console.log(`[base] ${step}: ${sig}`);
  return sig;
}

async function holdingAmount(account: PublicKey, source: PublicKey) {
  const info = await base.getAccountInfo(tesoroHoldingPda(account, source));
  if (!info) return 0n;
  const h: any = tesoro.coder.accounts.decode("holdingState", info.data);
  return BigInt(h.inner.amount.toString());
}
async function accountTotals(account: PublicKey) {
  const info = await base.getAccountInfo(account);
  const a: any = tesoro.coder.accounts.decode("tesoroAccount", info!.data);
  return { own: BigInt(a.inner.ownTotal.toString()), won: BigInt(a.inner.wonTotal.toString()) };
}

// ---------------------------------------------------------------------------------------------

async function setup() {
  // Fund the two test wallets.
  for (const kp of [k0, k1]) {
    if ((await base.getBalance(kp.publicKey)) < 0.4e9) {
      await sendBase("fund", [SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: 0.5e9 })], [deployer]);
    }
  }
  // Register holdem in tesoro_core with the PDA authority (admin = deployer).
  const cfgInfo = await base.getAccountInfo(tesoroConfigPda());
  const cfg: any = tesoro.coder.accounts.decode("config", cfgInfo!.data);
  const auth = addresses(1).authority;
  const g = gameAccounts(HOLDEM_PROGRAM_ID);
  if (!(await base.getAccountInfo(g.gameRecord))) {
    // The deployer is the program's upgrade authority, which is what tesoro_core checks.
    const ix = await tesoro.methods
      .registerGame(auth, 300)
      .accountsPartial({ payer: deployer.publicKey, control: deployer.publicKey, config: tesoroConfigPda(), gameProgram: g.gameProgram, programData: g.programData, studioRecipient: cfg.platformRecipient, gameRecord: g.gameRecord } as any)
      .instruction();
    await sendBase("register_game holdem (authority = PDA)", [ix], [deployer]);
  }
  // tesoro accounts and Gemas (a simulated Position + Advance each).
  for (const [i, kp] of [k0, k1].entries()) {
    const account = tesoroAccountPda(kp.publicKey);
    if (!(await base.getAccountInfo(account))) {
      const ix = await tesoro.methods
        .createAccount(Array(20).fill(0))
        .accountsPartial({ authority: kp.publicKey, account } as any)
        .instruction();
      await sendBase(`create_account p${i}`, [ix], [kp]);
    }
    if ((await accountTotals(account)).own === 0n) {
      const positionId = Array.from(anchor.web3.Keypair.generate().publicKey.toBytes());
      const position = PublicKey.findProgramAddressSync(
        [Buffer.from("position"), Buffer.from([0]), Buffer.from(positionId)],
        TESORO_CORE_PROGRAM_ID,
      )[0];
      const open = await tesoro.methods
        .openPosition({ solana: {} }, positionId, Keypair.generate().publicKey, 9, new anchor.BN(100e9), 1000)
        .accountsPartial({ oracle: oracle.publicKey, config: tesoroConfigPda(), ownerAccount: account, position } as any)
        .instruction();
      await sendBase(`open_position p${i} (simulated)`, [open], [oracle]);
      const source = PublicKey.findProgramAddressSync(
        [Buffer.from("source"), position.toBuffer(), Buffer.from(new Uint32Array([0]).buffer)],
        TESORO_CORE_PROGRAM_ID,
      )[0];
      const adv = await tesoro.methods
        .takeAdvance(6, new anchor.BN(150_000_000))
        .accountsPartial({
          oracle: oracle.publicKey,
          ownerAuthority: kp.publicKey,
          config: tesoroConfigPda(),
          ownerAccount: account,
          position,
          source,
          holding: tesoroHoldingPda(account, source),
        } as any)
        .instruction();
      await sendBase(`take_advance p${i} (simulated yield)`, [adv], [oracle, kp]);
      state[`source${i}`] = source.toBase58();
    }
  }
  save(STATE, state);
}

async function findSources() {
  // Recover each player's Holding by scanning holdings owned by their account.
  const out: PublicKey[] = [];
  for (const kp of [k0, k1]) {
    const account = tesoroAccountPda(kp.publicKey);
    const holdings = await base.getProgramAccounts(TESORO_CORE_PROGRAM_ID, {
      filters: [{ memcmp: { offset: 8 + 1, bytes: account.toBase58() } }],
    });
    const best = holdings
      .map((h) => ({ pk: h.pubkey, d: tesoro.coder.accounts.decode("holdingState", h.account.data) as any }))
      .filter((h) => BigInt(h.d.inner.amount.toString()) > 0n)
      .sort((a, b) => Number(BigInt(b.d.inner.amount.toString()) - BigInt(a.d.inner.amount.toString())))[0];
    out.push(best.pk);
  }
  return out;
}

async function openMatch(entry: number) {
  const matchId = BigInt(Date.now());
  state.matchId = matchId.toString();
  save(STATE, state);
  const [h0, h1] = await findSources();
  const open = await tesoro.methods
    .openMatch(new anchor.BN(matchId.toString()), HOLDEM_PROGRAM_ID, new anchor.BN(entry))
    .accountsPartial({
      playerAuthority: k0.publicKey,
      config: tesoroConfigPda(),
      ...gameAccounts(HOLDEM_PROGRAM_ID),
      playerAccount: tesoroAccountPda(k0.publicKey),
      matchState: tesoroMatchPda(matchId),
    } as any)
    .remainingAccounts([{ pubkey: h0, isSigner: false, isWritable: true }])
    .instruction();
  await sendBase("tesoro_core open_match (p0, entry 500)", [open], [k0]);
  const join = await tesoro.methods
    .joinMatch()
    .accountsPartial({
      playerAuthority: k1.publicKey,
      playerAccount: tesoroAccountPda(k1.publicKey),
      matchState: tesoroMatchPda(matchId),
      pair: pairPda(tesoroAccountPda(k0.publicKey), tesoroAccountPda(k1.publicKey)),
      systemProgram: SystemProgram.programId,
    } as any)
    .remainingAccounts([{ pubkey: h1, isSigner: false, isWritable: true }])
    .instruction();
  await sendBase("tesoro_core join_match (p1)", [join], [k1]);
  return matchId;
}

// ---------------------------------------------------------------------------------------------

async function table(id: bigint): Promise<Table> {
  for (let i = 0; i < 20; i++) {
    const t = await chain.readTable(p0, id);
    if (t) return t;
    await sleep(500);
  }
  throw new Error("cannot read table");
}

async function dealHand(id: bigint, first: boolean) {
  // Fresh secrets from both Players; the second bundles the VRF request.
  await chain.contributeEntropy(p0, id, false);
  await chain.contributeEntropy(p1, id, true);
  for (let i = 0; i < 40; i++) {
    try {
      await chain.deal(p0, id);
      return;
    } catch (e: any) {
      if (!String(e.message).includes("EntropyIncomplete") && !String(e.message).includes("0x1771") && !/custom program error/.test(e.message)) throw e;
      if (i === 15) await chain.requestVrf(p0, id).catch(() => {});
      await sleep(1500);
    }
  }
  throw new Error("deal never succeeded (VRF output missing)");
}

function describe(t: Table) {
  return `hand ${t.handNo} phase ${t.phase} stacks ${t.stacks} bets ${t.bets} pot ${t.pot} board ${t.board.map(cardName)} toAct ${t.toAct}`;
}

async function privacyChecks(id: bigint) {
  const ad = addresses(id);
  const tee = async (s: PlayerSigner) => chain.teeConnection(s);
  const read = async (s: PlayerSigner, a: PublicKey) => (await (await tee(s)).getAccountInfo(a).catch(() => null)) ? "readable" : "null";
  const own0 = await chain.readOwnHole(p0, id, 0);
  const own1 = await chain.readOwnHole(p1, id, 1);
  const cross0 = await read(p0, ad.hole1);
  const cross1 = await read(p1, ad.hole0);
  check_("player 0 reads own hole cards", !!own0, own0 && own0.cards.map(cardName));
  check_("player 1 reads own hole cards", !!own1, own1 && own1.cards.map(cardName));
  check_("player 0 cannot read player 1's hole cards", cross0 === "null", cross0);
  check_("player 1 cannot read player 0's hole cards", cross1 === "null", cross1);
  const decks = [await read(p0, ad.deck), await read(p1, ad.deck), await read(outsider, ad.deck)];
  check_("the Deck is unreadable by both Players and an outsider", decks.every((d) => d === "null"), decks);
  const outs = [await read(outsider, ad.hole0), await read(outsider, ad.hole1), await read(outsider, ad.gameMatch)];
  check_("an outsider reads neither hole account nor the table", outs.every((d) => d === "null"), outs);
  const seen = [...(own0?.cards ?? []), ...(own1?.cards ?? [])];
  check_("four distinct valid hole cards", new Set(seen).size === 4 && seen.every((c) => c < 52), seen.map(cardName));
  const baseHole = await base.getAccountInfo(ad.hole0);
  const bh: any = baseHole ? chain.program.coder.accounts.decode("hole", baseHole.data) : null;
  check_("the base-layer copy of a hole account shows no cards mid-match", !!bh && bh.cards.every((c: number) => c === 0), bh && Array.from(bh.cards));
  return { own0, own1 };
}

async function actUntilHandEnds(id: bigint, plan: (t: Table, seat: number) => ReturnType<typeof call> | null) {
  const startHand = (await table(id)).handNo;
  for (let guard = 0; guard < 40; guard++) {
    const t = await table(id);
    if (t.handNo !== startHand || t.status !== STATUS.live) return t;
    if (t.phase === PHASE.shuffle) return t;
    const seat = t.toAct;
    const action = plan(t, seat);
    if (!action) return t;
    await chain.act(players[seat], id, action);
  }
  throw new Error("hand did not end");
}

const facing = (t: Table, seat: number) => t.bets[seat] < (t.bets[0] > t.bets[1] ? t.bets[0] : t.bets[1]);
const shove = (t: Table, seat: number) => raise(t.bets[seat] + t.stacks[seat]);

async function settleAndCheck(id: bigint, expectRefund: boolean) {
  await chain.closeMatch(p0, id);
  await chain.finalize(outsider, id);
  const tm = await chain.readTesoroMatch(id);
  const key = expectRefund ? "refunded" : "settled";
  check_(`tesoro_core Match ${key} by the holdem PDA authority (CPI)`, key in tm.inner.status, Object.keys(tm.inner.status));
  const a0 = await accountTotals(tesoroAccountPda(k0.publicKey));
  const a1 = await accountTotals(tesoroAccountPda(k1.publicKey));
  return { p0: a0.own + a0.won, p1: a1.own + a1.won };
}

async function beforeTotals() {
  const a0 = await accountTotals(tesoroAccountPda(k0.publicKey));
  const a1 = await accountTotals(tesoroAccountPda(k1.publicKey));
  return { p0: a0.own + a0.won, p1: a1.own + a1.won };
}

async function runNoShow() {
  await setup();
  const id = await openMatch(500);
  const escrowed = await beforeTotals();
  await chain.createAndDelegate(p0, id, k0.publicKey, k1.publicKey, SPEED_TURBO);
  await chain.start(p0, id);
  await chain.contributeEntropy(p0, id, false); // player 1 never shows
  let t = await table(id);
  const wait = t.deadline * 1000 - Date.now() + 3000;
  console.log(`player 1 never contributes; waiting ${Math.round(wait / 1000)}s for the shuffle clock`);
  if (wait > 0) await sleep(wait);
  await chain.claimTimeout(outsider, id);
  t = await table(id);
  check_("no-show: hand one cancelled by a permissionless claim_timeout", t.status === STATUS.cancelled, describe(t));
  const after = await settleAndCheck(id, true);
  check_("no-show: both entries refunded through tesoro_core", after.p0 === escrowed.p0 + 500n && after.p1 === escrowed.p1 + 500n, { escrowed: { p0: escrowed.p0.toString(), p1: escrowed.p1.toString() }, after: { p0: after.p0.toString(), p1: after.p1.toString() } });
  evidence.summary = { matchId: id.toString() };
  save(EVIDENCE, evidence);
}

async function runIdle() {
  await setup();
  const id = await openMatch(500);
  const escrowed = await beforeTotals();
  await chain.createAndDelegate(p0, id, k0.publicKey, k1.publicKey, SPEED_TURBO);
  await chain.start(p0, id);
  const idle = 0;
  for (let guard = 0; guard < 12; guard++) {
    let t = await table(id);
    if (t.status !== STATUS.live) break;
    if (t.phase === PHASE.shuffle) await dealHand(id, false);
    for (let step = 0; step < 12; step++) {
      t = await table(id);
      if (t.status !== STATUS.live || t.phase === PHASE.shuffle) break;
      if (t.toAct === idle) {
        const wait = t.deadline * 1000 - Date.now() + 3000;
        console.log(`seat ${idle} idle at hand ${t.handNo} (missed ${t.missed[idle]}); waiting ${Math.round(wait / 1000)}s`);
        if (wait > 0) await sleep(wait);
        await chain.claimTimeout(outsider, id);
        const n = await table(id);
        console.log(`claim_timeout -> ${describe(n)} missed ${n.missed}`);
      } else {
        await chain.act(players[t.toAct], id, facing(t, t.toAct) ? call() : check());
      }
    }
  }
  const t = await table(id);
  check_("idle Player forfeits after three missed turns in a row", t.status === STATUS.over && t.winner === 1 && t.missed[idle] >= 3, { status: t.status, winner: t.winner, missed: t.missed });
  const after = await settleAndCheck(id, false);
  check_("forfeit settled: the present Player gets 950 (own 500 + 500 minus 5% fee)", after.p1 === escrowed.p1 + 950n && after.p0 === escrowed.p0, { p0: after.p0.toString(), p1: after.p1.toString() });
  evidence.summary = { matchId: id.toString() };
  save(EVIDENCE, evidence);
}

async function run() {
  if (MODE === "noshow") return runNoShow();
  if (MODE === "idle") return runIdle();
  if (!resume) await setup();
  let id: bigint;
  if (resume && state.matchId) id = BigInt(state.matchId);
  else {
    id = await openMatch(500);
    const [gA, gB] = [await accountTotals(tesoroAccountPda(k0.publicKey)), await accountTotals(tesoroAccountPda(k1.publicKey))];
    state.before = { p0: (gA.own + gA.won).toString(), p1: (gB.own + gB.won).toString() };
    save(STATE, state);
    await chain.createAndDelegate(p0, id, k0.publicKey, k1.publicKey, SPEED_TURBO);
    const own = await base.getAccountInfo(addresses(id).gameMatch);
    check_("table delegated to the TEE validator", !!own && own.owner.toBase58() === "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh", own?.owner.toBase58());
    await chain.start(p0, id);
    let t = await table(id);
    check_("Match started with equal Chips and blinds posted", t.stacks[0] + t.bets[0] === 1500n && t.stacks[1] + t.bets[1] === 1500n, describe(t));
  }
  console.log("match", id.toString());

  // Hand 1: check down to showdown; verify privacy and that board cards reveal as dealt.
  let t = await table(id);
  if (t.handNo === 1 && t.phase === PHASE.shuffle) {
    await dealHand(id, true);
    await privacyChecks(id);
    t = await table(id);
    check_("no board card is public before the flop", t.board.every((c) => c === 255), t.board);
    const flopSeen: number[] = [];
    t = await actUntilHandEnds(id, (tt, seat) => {
      flopSeen.push(tt.board.filter((c) => c < 52).length);
      return facing(tt, seat) ? call() : check();
    });
    check_("board revealed street by street (0,3,4,5 cards seen)", [0, 3, 4, 5].every((n) => flopSeen.includes(n)), flopSeen);
    const lh = t.lastHand;
    check_("showdown reveals both hole cards and the full board", lh.showdown && lh.shown.flat().every((c) => c < 52) && lh.board.every((c) => c < 52), { shown: lh.shown.flat().map(cardName), board: lh.board.map(cardName), result: lh.result });
    console.log(describe(t));
  }

  // Hand 2: the player to act goes idle: a third party claims the timeout (auto fold).
  t = await table(id);
  if (t.handNo === 2 && t.phase === PHASE.shuffle && t.status === STATUS.live) {
    await dealHand(id, false);
    t = await table(id);
    const wait = t.deadline * 1000 - Date.now() + 3000;
    console.log(`seat ${t.toAct} goes idle; waiting ${Math.max(0, Math.round(wait / 1000))}s for the turn clock`);
    if (wait > 0) await sleep(wait);
    const before = t.handNo;
    const idle = t.toAct;
    await chain.claimTimeout(outsider, id);
    t = await table(id);
    check_(
      "permissionless claim_timeout auto-folded the idle Player and started the next hand",
      t.handNo === before + 1 && t.lastHand.result === 1 - idle && t.missed[idle] === 1,
      { idle, missed: t.missed, result: t.lastHand.result },
    );
  }

  // Later hands: shove and call until one Player holds every Chip.
  for (let guard = 0; guard < 30; guard++) {
    t = await table(id);
    if (t.status !== STATUS.live) break;
    if (t.phase === PHASE.shuffle) await dealHand(id, false);
    t = await actUntilHandEnds(id, (tt, seat) => (facing(tt, seat) ? call() : shove(tt, seat)));
    console.log(describe(t));
  }
  t = await table(id);
  check_("Match over: one Player holds all 3,000 Chips", t.status === STATUS.over && (t.stacks[t.winner] === 3000n), describe(t));
  console.log("winner seat", t.winner, "hands", t.handNo);

  // Commit and settle on the base layer.
  await chain.closeMatch(p0, id);
  const settleSig = await chain.finalize(outsider, id);
  const tm = await chain.readTesoroMatch(id);
  check_("tesoro_core Match Settled by the holdem PDA authority (CPI)", "settled" in tm.inner.status, Object.keys(tm.inner.status));
  const after = { p0: await accountTotals(tesoroAccountPda(k0.publicKey)), p1: await accountTotals(tesoroAccountPda(k1.publicKey)) };
  const win = t.winner;
  const gain = win === 0 ? after.p0.own + after.p0.won - BigInt(state.before.p0) : after.p1.own + after.p1.won - BigInt(state.before.p1);
  check_("winner receives own 500 back plus loser's 500 minus 5% fee (950 total)", gain === 950n, gain.toString());
  const baseTable = await chain.readTableOnBase(id);
  check_("hidden accounts wiped on the base layer after commit", !!baseTable && baseTable.finalized, baseTable && { status: baseTable.status, finalized: baseTable.finalized });
  const deck = await base.getAccountInfo(addresses(id).deck);
  const d: any = deck ? chain.program.coder.accounts.decode("deck", deck.data) : null;
  check_("Deck is back on the base layer with no entropy, VRF output or cards", !!d && d.cards.every((c: number) => c === 0) && d.entropy.every((c: number) => c === 0), d && { dealt: d.dealt });
  evidence.summary = { matchId: id.toString(), winnerSeat: win, hands: t.handNo, settleSig, addresses: Object.fromEntries(Object.entries(addresses(id)).map(([k, v]) => [k, v.toBase58()])), players: [k0.publicKey.toBase58(), k1.publicKey.toBase58()] };
  save(EVIDENCE, evidence);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
