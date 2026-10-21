/**
 * One full async Block Puzzle Match (the opener plays before the joiner exists) on Solana devnet + the MagicBlock devnet TEE, driven only through
 * app/src/games/block-puzzle/chain.ts. Records signatures and checks to evidence.json.
 *
 *   pnpm install --ignore-workspace && pnpm match
 *
 * Economy upgrade (ADR 0013): the entry is drawn from each Player's basket into a Pot, the Match is
 * `["match", opener Account, n]`, and the settlement is `settle` (starts the run) + `match_chunk`s + `close_match`.
 *
 * Precondition (ticket 24 does it after the wipe and deploy): tesoro_core is initialised with set_economy, the
 * Game is registered (and listed), and the two test wallets (~/.config/tesoro/block-puzzle-testers.json) hold at
 * least ENTRY playable Gemas each (native Position + Advance, scripts/native-position or the app). Env: ENTRY
 * (default 500), RESUME=<match address> to conclude an earlier run.
 */
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { verifyTeeRpcIntegrity } from "@magicblock-labs/ephemeral-rollups-sdk";
import fs from "fs";
import os from "os";
import path from "path";
import {
  BASE_RPC,
  BLOCK_PUZZLE_PROGRAM_ID,
  BlockPuzzleChain,
  TEE_RPC,
  keypairSigner,
  type Move,
} from "../../../app/src/games/block-puzzle/chain";
import { basketPda, receiptPda, spillPda } from "../../../app/src/games/block-puzzle/match-accounts";
import { apply, dims, fitsAt, handBase, newState, pieceAt, replay, SIZE, HAND } from "../../../app/src/games/block-puzzle/engine";

const HERE = __dirname;
const ROOT = path.join(HERE, "../../..");
const EVIDENCE = path.join(HERE, "evidence.json");
const cfgDir = path.join(os.homedir(), ".config/tesoro");
const readKp = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(f, "utf8"))));
const loadOrCreate = (f: string) => {
  if (fs.existsSync(f)) return readKp(f);
  const kp = Keypair.generate();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
};
const ENTRY = Number(process.env.ENTRY ?? 500);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bpIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/block_puzzle.json"), "utf8"));
const coreIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/tesoro_core.json"), "utf8"));

const base = new Connection(process.env.BASE_RPC ?? BASE_RPC, "confirmed");
const chain = new BlockPuzzleChain({ base, blockPuzzleIdl: bpIdl, coreIdl });
const core = chain.core as Program<any>;

const deployer = readKp(path.join(os.homedir(), ".config/solana/dev-2026-10.json"));
const oracle = loadOrCreate(path.join(cfgDir, "oracle.json"));
const testers = (() => {
  const f = path.join(cfgDir, "block-puzzle-testers.json");
  if (!fs.existsSync(f)) {
    fs.writeFileSync(f, JSON.stringify([Array.from(Keypair.generate().secretKey), Array.from(Keypair.generate().secretKey)]), { mode: 0o600 });
  }
  return (JSON.parse(fs.readFileSync(f, "utf8")) as number[][]).map((k) => Keypair.fromSecretKey(Uint8Array.from(k)));
})();
const [p0, p1] = testers;
const S = { d: keypairSigner(deployer), o: keypairSigner(oracle), p0: keypairSigner(p0), p1: keypairSigner(p1) };

const evidence: any = fs.existsSync(EVIDENCE) ? JSON.parse(fs.readFileSync(EVIDENCE, "utf8")) : { runs: [] };
const RESUME = process.env.RESUME;
const run: any = (RESUME && evidence.runs.find((r: any) => r.match === RESUME)) || { at: new Date().toISOString(), txs: [], checks: [] };
if (!evidence.runs.includes(run)) evidence.runs.push(run);
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const save = () => fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
function rec(step: string, sig: string, layer: "base" | "tee") {
  run.txs.push({ step, layer, sig, link: layer === "base" ? explorer(sig) : undefined });
  save();
  console.log(`[${layer}] ${step}: ${sig}`);
}
function check(name: string, pass: boolean, detail: unknown) {
  run.checks = run.checks.filter((c: any) => c.name !== name);
  run.checks.push({ name, pass, detail });
  save();
  console.log(`${pass ? "PASS" : "FAIL"} ${name} :: ${typeof detail === "string" ? detail : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  if (!pass) process.exitCode = 1;
}

const exists = async (k: PublicKey) => !!(await base.getAccountInfo(k));

async function ensureAccount(signer: ReturnType<typeof keypairSigner>, label: string) {
  const account = BlockPuzzleChain.coreAccount(signer.publicKey);
  if (await exists(account)) return account;
  const ix = await core.methods
    .createAccount(Array(20).fill(0))
    .accountsPartial({ authority: signer.publicKey, account, basket: basketPda(account), spill: spillPda(account), systemProgram: SystemProgram.programId })
    .instruction();
  rec(`create_account ${label}`, await chain.sendBase(signer, [ix]), "base");
  return account;
}

/** Playable Gemas of an Account: own plus won totals in the headers of its basket and spill. */
const gemas = async (account: PublicKey) => {
  const infos = await base.getMultipleAccountsInfo([basketPda(account), spillPda(account)]);
  return infos.reduce((sum, i) => (i ? sum + i.data.readBigUInt64LE(8 + 40) + i.data.readBigUInt64LE(8 + 48) : sum), 0n);
};

/** First fitting placement for the first unused piece, until `n` moves or game over. */
function greedy(seed: bigint, n: number): Move[] {
  let st = newState(seed);
  const out: Move[] = [];
  while (out.length < n && !st.over) {
    const base0 = handBase(st);
    let played = false;
    for (let slot = 0; slot < HAND && !played; slot++) {
      if ((st.used >> slot) & 1) continue;
      const piece = pieceAt(seed, base0 + slot);
      const [w, h] = dims(piece);
      for (let y = 0; y <= SIZE - h && !played; y++)
        for (let x = 0; x <= SIZE - w && !played; x++)
          if (fitsAt(st, piece, x, y)) {
            const mv = { piece: base0 + slot, x, y };
            st = apply(st, mv).state;
            out.push(mv);
            played = true;
          }
    }
    if (!played) break;
  }
  return out;
}

async function main() {
  if (RESUME) {
    const a = (id: number) => BlockPuzzleChain.coreAccount((id === 0 ? p0 : p1).publicKey);
    await conclude(new PublicKey(RESUME), run.gemasBefore.map(BigInt), a(0), a(1));
    return;
  }
  for (const kp of [p0, p1, oracle]) {
    const bal = await base.getBalance(kp.publicKey);
    if (bal < 0.15e9) {
      const ix = SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: 0.2e9 });
      rec(`fund ${kp.publicKey.toBase58().slice(0, 6)}`, await chain.sendBase(S.d, [ix]), "base");
    }
  }
  const a0 = { account: await ensureAccount(S.p0, "p0") };
  const a1 = { account: await ensureAccount(S.p1, "p1") };
  const before = [await gemas(a0.account), await gemas(a1.account)];
  console.log("gemas before", before);
  if (before.some((g) => g < BigInt(ENTRY))) throw new Error(`Each tester needs ${ENTRY} playable Gemas (native Position + Advance first): ${before.join(", ")}`);
  run.gemasBefore = before.map(String);

  let attest: true | string = "";
  for (let i = 0; i < 4 && attest !== true; i++) attest = await verifyTeeRpcIntegrity(TEE_RPC).then(() => true as const).catch((e) => String(e));
  check("TEE RPC attestation (verifyTeeRpcIntegrity)", attest === true, attest);

  const opened = await chain.openMatch(S.p0, ENTRY);
  const matchId = opened.match;
  const A = BlockPuzzleChain.addresses(matchId);
  run.match = A.match.toBase58();
  run.session = A.session.toBase58();
  run.vault = A.vault.toBase58();
  run.boards = A.boards.map((b) => b.toBase58());
  run.players = [p0.publicKey.toBase58(), p1.publicKey.toBase58()];
  const tee = new Connection(TEE_RPC, "confirmed");

  // ---- the opener alone: open, prepare, play a whole run before anyone is paired ----
  rec("open_match + open_session (p0, ENTRY Gemas drawn from the basket; Match stays Open)", opened.sig, "base");
  // F-01: a delegation naming any validator but the TEE is refused by the Game before it reaches the delegation program.
  const rogue = Keypair.generate().publicKey;
  const rogueIx = await chain.bp.methods
    .delegateOpener()
    .accountsPartial({ payer: S.d.publicKey, session: A.session, board0: A.boards[0], vault: A.vault, validator: rogue })
    .instruction();
  const rogueErr = await chain.sendBase(S.d, [rogueIx]).then(() => "ACCEPTED", (e) => String(e.message ?? e).replace(/\s+/g, " ").slice(0, 300));
  check("F-01: delegate_opener naming a non-TEE validator is refused", rogueErr !== "ACCEPTED" && /InvalidValidator|6020|0x1784/.test(rogueErr), rogueErr);
  const stillBase = (await base.getAccountInfo(A.boards[0]))!.owner.equals(BLOCK_PUZZLE_PROGRAM_ID);
  check("F-01: Board 0 is still owned by the Game (not delegated) after the refused attempt", stillBase, stillBase);
  rec("delegate_opener (Board 0 + SeedVault to the TEE validator)", await chain.delegateOpener(S.d, matchId), "base");
  rec("init_vault_permission (private, zero members)", await chain.initVaultPermission(S.p0, matchId), "tee");
  rec("init_permission p0", await chain.initPermission(S.p0, matchId, 0), "tee");
  const ownBefore = await chain.fetchOwnBoard(S.p0, matchId, 0);
  check("before begin_run p0's own Board holds no Seed", !!ownBefore && ownBefore.seed.isZero(), ownBefore ? { seed: ownBefore.seed.toString() } : null);
  rec("request_seed (VRF inside the TEE)", await chain.requestSeed(S.p0, matchId), "tee");
  let ready = false;
  for (let i = 0; i < 40 && !ready; i++) {
    await sleep(1500);
    ready = await chain.seedReady(S.p0, matchId);
  }
  check("VRF callback wrote the Seed into the SeedVault (check_seed succeeds)", ready, ready ? "ready" : "timeout");
  if (!ready) throw new Error("seed never arrived");

  // Nobody can read the SeedVault: not the opener, not the future joiner, not an anonymous client.
  const vaultReads = await Promise.all([
    (await chain.tee(S.p0)).getAccountInfo(A.vault).catch(() => null),
    (await chain.tee(S.p1)).getAccountInfo(A.vault).catch(() => null),
    tee.getAccountInfo(A.vault).catch(() => null),
  ]);
  check("SeedVault is unreadable by p0, p1 and an anonymous TEE client (zero-member permission)", vaultReads.every((r) => r === null), vaultReads.map((r) => (r ? "READABLE" : "null")));
  const baseVault: any = chain.bp.coder.accounts.decode("seedVault", (await base.getAccountInfo(A.vault))!.data);
  check("base-layer copy of the SeedVault holds no Seed while delegated", baseVault.seed.isZero() && !baseVault.ready, { ready: baseVault.ready });

  const begun = await chain.beginRun(S.p0, matchId, 0);
  rec("begin_run p0 (Seed copied into p0's private Board)", begun.sig, "tee");
  const seed = begun.seed;
  run.seed = seed.toString();
  const strong = greedy(seed, 30);
  const weak = greedy(seed, 12);
  const expected = [replay(seed, strong), replay(seed, weak)].map((r) => (r.ok ? r.state.score : -1));
  run.expectedScores = expected;
  (await chain.play(S.p0, matchId, 0, strong)).forEach((s, i) => rec(`play p0 batch ${i}`, s, "tee"));
  rec("finish p0", await chain.finish(S.p0, matchId, 0), "tee");
  const openMatchState: any = await core.account.matchState.fetch(A.match);
  check("opener finished their run while the Match is still Open (no opponent yet)", Object.keys(openMatchState.inner.stage)[0] === "open", openMatchState.inner.stage);
  run.openerFinishedAt = new Date().toISOString();
  const own = await chain.fetchOwnBoard(S.p0, matchId, 0);
  check("p0 reads own Board in the TEE (score visible)", !!own && own.score === expected[0], own ? { score: own.score, moves: own.moves } : own);
  const anon = await tee.getAccountInfo(A.boards[0]).catch(() => null);
  check("unauthenticated TEE read of p0's Board fails", anon === null, anon ? "READABLE" : "null");
  const baseCopy: any = chain.bp.coder.accounts.decode("board", (await base.getAccountInfo(A.boards[0]))!.data);
  check("base-layer copy of p0's Board holds no moves and no Seed", baseCopy.moves === 0 && baseCopy.score === 0 && baseCopy.seed.isZero(), { moves: baseCopy.moves, score: baseCopy.score });

  // ---- the joiner arrives later ----
  console.log("opener is done; joiner arrives in 20 s");
  await sleep(20_000);
  rec("join_match + join_session (p1)", await chain.joinMatch(S.p1, matchId), "base");
  const session = await chain.fetchSession(matchId);
  const match: any = await core.account.matchState.fetch(A.match);
  check(
    "join extended the tesoro_core refund deadline past the 24h submission deadline",
    Number(match.inner.deadline.toString()) >= Number(session.deadline.toString()) + 3600,
    { matchDeadline: match.inner.deadline.toString(), submissionDeadline: session.deadline.toString() },
  );
  const foreign = await chain.fetchOwnBoard(S.p1, matchId, 0);
  check("joiner p1 cannot read the opener's Board in the TEE", foreign === null, foreign === null ? "null (hidden)" : "READABLE");
  rec("delegate_joiner (Board 1)", await chain.delegateJoiner(S.d, matchId), "base");
  rec("init_permission p1", await chain.initPermission(S.p1, matchId, 1), "tee");
  const preSeal = await chain.sealAndCommit(S.d, matchId).then(() => "SEALED EARLY").catch((e) => String(e.message).split("\n")[0].slice(0, 120));
  check("seal is refused while the joiner can still play (opener's moves stay private)", preSeal !== "SEALED EARLY", preSeal);
  const b1Before = await chain.fetchOwnBoard(S.p1, matchId, 1);
  check("before begin_run p1's own Board holds no Seed", !!b1Before && b1Before.seed.isZero(), b1Before ? { seed: b1Before.seed.toString() } : null);
  const begun1 = await chain.beginRun(S.p1, matchId, 1);
  rec("begin_run p1 (same Seed)", begun1.sig, "tee");
  check("p1 receives the same Seed at begin_run", begun1.seed === seed, { p1: begun1.seed.toString(), p0: seed.toString() });
  (await chain.play(S.p1, matchId, 1, weak)).forEach((s, i) => rec(`play p1 batch ${i}`, s, "tee"));
  rec("finish p1", await chain.finish(S.p1, matchId, 1), "tee");

  const sealed = await chain.sealAndCommit(S.d, matchId);
  rec("seal + commit_boards (permissions closed, Boards + SeedVault undelegated)", sealed.teeSig, "tee");
  if (sealed.commitSig) rec("commit on base layer", sealed.commitSig, "base");

  const b0: any = await chain.bp.account.board.fetch(A.boards[0]);
  const b1: any = await chain.bp.account.board.fetch(A.boards[1]);
  check("committed scores equal the TS engine replay of the same moves", b0.score === expected[0] && b1.score === expected[1], { onchain: [b0.score, b1.score], expected });
  check("moves are public only after commit (log matches)", b0.log[0] === (strong[0].piece | (strong[0].x << 16) | (strong[0].y << 24)), b0.log.slice(0, 3));

  await conclude(matchId, before, a0.account, a1.account);
}

async function conclude(matchId: PublicKey, before: bigint[], acc0: PublicKey, acc1: PublicKey) {
  const a0 = { account: acc0 };
  const a1 = { account: acc1 };
  if (!(await chain.fetchSession(matchId)).settled) {
    const { sig: settleSig, result } = await chain.settle(S.d, matchId);
    rec(`settle via CPI to tesoro_core (result: ${result}): starts the run, writes the receipt`, settleSig, "base");
  }
  const res = await chain.fetchResult(matchId);
  run.result = { ...res, seed: res.seed.toString() };
  check("Match settled: higher score wins", res.settled && res.result === "opener", res);
  const stage = await chain.runChunks(S.d, matchId);
  check("the settlement run finished in chunks (Match Closed)", stage === "closed", stage);
  const receipt = await base.getAccountInfo(receiptPda(matchId));
  check("the settlement receipt exists", !!receipt, receipt ? "present" : "missing");
  rec("close_match (rents back)", await chain.closeMatch(S.d, matchId), "base");
  check("close_match closed the Match account", !(await exists(matchId)), "closed");
  const after = [await gemas(a0.account), await gemas(a1.account)];
  const won = after[0] - before[0];
  check("winner received the loser's entry minus the fees (Platform, Studio, Leaderboard); loser lost the entry", won > (BigInt(ENTRY) * 8n) / 10n && won < BigInt(ENTRY) && after[1] === before[1] - BigInt(ENTRY), { before: before.map(String), after: after.map(String) });

  let doubleSettle = "";
  try {
    await chain.settle(S.d, matchId);
    doubleSettle = "SECOND SETTLE SUCCEEDED";
  } catch (e: any) {
    doubleSettle = String(e.message).split("\n")[0].slice(0, 160);
  }
  check("no double settlement", doubleSettle !== "SECOND SETTLE SUCCEEDED", doubleSettle);
  console.log(JSON.stringify(run.result, null, 1));
}

main().catch((e) => {
  console.error(e);
  save();
  process.exit(1);
});
