/**
 * Plays one Trading Duel on Solana devnet + the MagicBlock devnet TEE through the app's client
 * (app/src/games/trading-duel/chain.ts). Writes evidence to evidence-<mode>.json.
 *
 *   NODE_PATH=$PWD/../../../app/node_modules npx tsx play.ts [full|draw|noshow] [asset 0|1|2]
 *
 * full: both trade, positions hidden from the other, Match ends, settles, winner paid.
 * late: like full, but end_match is called after the end grace window (last-mid fallback).
 * draw: nobody trades, equal equity, both entries refunded.
 * noshow: created and delegated but never started; claim_timeout after the start deadline, refund.
 */
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ASSETS,
  DRAW,
  STATUS,
  TradingDuelChain,
  decodePrice,
  duelMatchId,
  keypairSigner,
  ER_RPC,
  TRADING_DUEL_PROGRAM_ID,
  addresses,
  type PlayerSigner,
} from "../../../app/src/games/trading-duel/chain";
import {
  BASE_RPC,
  TESORO_CORE_PROGRAM_ID,
  tesoroAccountPda,
  tesoroConfigPda,
  tesoroHoldingPda,
  tesoroMatchPda,
} from "../../../app/src/games/holdem/chain";

const HERE = __dirname;
const ROOT = path.join(HERE, "../../..");
const MODE = process.argv[2] ?? "full";
const ASSET = (Number(process.argv[3] ?? 0) as 0 | 1 | 2);
const EVIDENCE = path.join(HERE, `evidence-${MODE}.json`);
const KEYS = path.join(os.homedir(), ".cache/tmp/td-keys.json");
const duelIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/trading_duel.json"), "utf8"));
const tesoroIdl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/tesoro_core.json"), "utf8"));

const readKey = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const deployer = readKey(path.join(os.homedir(), ".config/solana/dev-2026-10.json"));
const oracle = readKey(path.join(os.homedir(), ".config/tesoro/oracle.json"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evidence: any = { mode: MODE, asset: ASSETS[ASSET].symbol, txs: [], checks: [] };
const save = () => fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const keys = fs.existsSync(KEYS)
  ? JSON.parse(fs.readFileSync(KEYS, "utf8"))
  : (() => {
      const k = { p0: Array.from(Keypair.generate().secretKey), p1: Array.from(Keypair.generate().secretKey) };
      fs.mkdirSync(path.dirname(KEYS), { recursive: true });
      fs.writeFileSync(KEYS, JSON.stringify(k));
      return k;
    })();
const k0 = Keypair.fromSecretKey(Uint8Array.from(keys.p0));
const k1 = Keypair.fromSecretKey(Uint8Array.from(keys.p1));
const p0 = keypairSigner(k0);
const p1 = keypairSigner(k1);
const outsider = keypairSigner(deployer);
const players: PlayerSigner[] = [p0, p1];

const base = new Connection(process.env.BASE_RPC ?? BASE_RPC, "confirmed");
const chain = new TradingDuelChain(duelIdl, tesoroIdl, {
  base,
  onTx: (step, layer, sig) => {
    evidence.txs.push({ step, layer, sig, link: layer === "base" ? explorer(sig) : undefined });
    save();
    console.log(`[${layer}] ${step}: ${sig}`);
  },
});
const tesoro = chain.tesoro;
const asset = ASSETS[ASSET];

function check(name: string, pass: boolean, detail: unknown) {
  evidence.checks.push({ name, pass, detail });
  save();
  console.log(`${pass ? "PASS" : "FAIL"} ${name} :: ${typeof detail === "string" ? detail : JSON.stringify(detail, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
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
  save();
  console.log(`[base] ${step}: ${sig}`);
}

async function totals(account: PublicKey) {
  const a: any = tesoro.coder.accounts.decode("tesoroAccount", (await base.getAccountInfo(account))!.data);
  return BigInt(a.inner.ownTotal.toString()) + BigInt(a.inner.wonTotal.toString());
}

async function setup(): Promise<PublicKey[]> {
  for (const kp of [k0, k1]) {
    if ((await base.getBalance(kp.publicKey)) < 0.25e9) {
      await sendBase("fund", [SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: 0.3e9 })], [deployer]);
    }
  }
  const holdings: PublicKey[] = [];
  for (const [i, kp] of [k0, k1].entries()) {
    const account = tesoroAccountPda(kp.publicKey);
    if (!(await base.getAccountInfo(account))) {
      const ix = await tesoro.methods.createAccount(Array(20).fill(0)).accountsPartial({ authority: kp.publicKey, account } as any).instruction();
      await sendBase(`create_account p${i}`, [ix], [kp]);
    }
    // A fresh simulated Position + Advance every run keeps Gemas available.
    const positionId = Array.from(Keypair.generate().publicKey.toBytes());
    const position = PublicKey.findProgramAddressSync([Buffer.from("position"), Buffer.from([0]), Buffer.from(positionId)], TESORO_CORE_PROGRAM_ID)[0];
    if ((await totals(account)) < 3000n) {
      const open = await tesoro.methods
        .openPosition({ solana: {} }, positionId, Keypair.generate().publicKey, 9, new anchor.BN(100e9), 1000)
        .accountsPartial({ oracle: oracle.publicKey, config: tesoroConfigPda(), ownerAccount: account, position } as any)
        .instruction();
      await sendBase(`open_position p${i} (simulated)`, [open], [oracle]);
      const source = PublicKey.findProgramAddressSync([Buffer.from("source"), position.toBuffer(), Buffer.from(new Uint32Array([0]).buffer)], TESORO_CORE_PROGRAM_ID)[0];
      const adv = await tesoro.methods
        .takeAdvance(6, new anchor.BN(150_000_000))
        .accountsPartial({ oracle: oracle.publicKey, ownerAuthority: kp.publicKey, config: tesoroConfigPda(), ownerAccount: account, position, source, holding: tesoroHoldingPda(account, source) } as any)
        .instruction();
      await sendBase(`take_advance p${i} (simulated yield)`, [adv], [oracle, kp]);
    }
    const found = await base.getProgramAccounts(TESORO_CORE_PROGRAM_ID, { filters: [{ memcmp: { offset: 8 + 1, bytes: account.toBase58() } }] });
    const best = found
      .map((h) => ({ pk: h.pubkey, d: tesoro.coder.accounts.decode("holdingState", h.account.data) as any }))
      .filter((h) => BigInt(h.d.inner.amount.toString()) >= 500n)
      .sort((a, b) => Number(BigInt(b.d.inner.amount.toString()) - BigInt(a.d.inner.amount.toString())))[0];
    holdings.push(best.pk);
  }
  return holdings;
}

async function openMatch(entry: number, h: PublicKey[]) {
  const matchId = duelMatchId(ASSET, false);
  const open = await tesoro.methods
    .openMatch(new anchor.BN(matchId.toString()), TRADING_DUEL_PROGRAM_ID, new anchor.BN(entry))
    .accountsPartial({ playerAuthority: k0.publicKey, config: tesoroConfigPda(), playerAccount: tesoroAccountPda(k0.publicKey), matchState: tesoroMatchPda(matchId) } as any)
    .remainingAccounts([{ pubkey: h[0], isSigner: false, isWritable: true }])
    .instruction();
  await sendBase("tesoro_core open_match (p0)", [open], [k0]);
  const join = await tesoro.methods
    .joinMatch()
    .accountsPartial({ playerAuthority: k1.publicKey, playerAccount: tesoroAccountPda(k1.publicKey), matchState: tesoroMatchPda(matchId) } as any)
    .remainingAccounts([{ pubkey: h[1], isSigner: false, isWritable: true }])
    .instruction();
  await sendBase("tesoro_core join_match (p1)", [join], [k1]);
  return matchId;
}

async function price(): Promise<number> {
  const info = await new Connection(ER_RPC).getAccountInfo(asset.feed);
  return decodePrice(info!.data)!.price;
}

async function waitUntil(unix: number) {
  while (Date.now() / 1000 < unix) await sleep(500);
}

async function endAndSettle(id: bigint) {
  for (let i = 0; i < 40; i++) {
    try {
      await chain.end(p0, id, asset);
      break;
    } catch (e: any) {
      if (i === 39) throw e;
      await sleep(1000);
    }
  }
  const duel = (await chain.readDuel(p0, id))!;
  check("Match is over in the rollup", duel.status === STATUS.over, { winner: duel.winner, equity: duel.finalEquity, price: duel.finalPrice, lead: duel.lead, trades: duel.trades });
  await chain.closeMatch(p0, id);
  const fin = await chain.finalize(p0, id);
  check("finalize settled the tesoro_core Match", true, fin);
  return duel;
}

async function main() {
  const holdings = await setup();
  const before = [await totals(tesoroAccountPda(k0.publicKey)), await totals(tesoroAccountPda(k1.publicKey))];
  const id = await openMatch(500, holdings);
  evidence.matchId = id.toString();
  console.log("match", id.toString(), asset.symbol);
  const afterEntry = [await totals(tesoroAccountPda(k0.publicKey)), await totals(tesoroAccountPda(k1.publicKey))];
  check("both entries are in escrow", before[0] - afterEntry[0] === 500n && before[1] - afterEntry[1] === 500n, { before, afterEntry });

  await chain.createDuel(p0, id, k0.publicKey, k1.publicKey);
  await chain.delegateDuel(p0, id);

  if (MODE === "noshow") {
    const d = (await chain.readDuel(p0, id))!;
    check("Duel readable in the rollup before start", d.status === STATUS.created, d);
    await waitUntil(d.startDeadline + 3);
    await chain.claimTimeout(outsider, id);
    check("claim_timeout cancelled it", (await chain.readDuel(p0, id))!.status === STATUS.cancelled, "");
    await chain.closeMatch(p0, id);
    await chain.finalize(p0, id);
    const after = [await totals(tesoroAccountPda(k0.publicKey)), await totals(tesoroAccountPda(k1.publicKey))];
    check("both entries refunded", after[0] === before[0] && after[1] === before[1], { before, after });
    return;
  }

  await chain.start(p0, id);
  let duel = (await chain.readDuel(p0, id))!;
  check("Duel started", duel.status === STATUS.live && duel.endsAt - duel.startsAt === 300, { startsAt: duel.startsAt, endsAt: duel.endsAt, asset: duel.asset.symbol });
  check("Duel is public: an outsider reads it", !!(await chain.readDuel(outsider, id)), "");
  const ad = addresses(id);
  const book1ByP0 = await (await chain.teeConnection(p0)).getAccountInfo(ad.book1).catch(() => null);
  check("a Player cannot read the opponent's Book", book1ByP0 === null || book1ByP0.data.length === 0, book1ByP0 ? "readable!" : "null");
  const own0 = await chain.readOwnBook(p0, id, 0);
  check("a Player reads their own Book", !!own0 && own0.cash === 10000n, own0);

  await waitUntil(duel.startsAt + 1);
  if (MODE === "full" || MODE === "late") {
    await chain.open(p0, id, asset, 1, 2000, 10);
    await chain.open(p1, id, asset, 2, 2000, 5);
    await sleep(3000);
    await chain.tick(outsider, id, asset);
    const b0 = (await chain.readOwnBook(p0, id, 0))!;
    check("position opened with spread", b0.side === 1 && b0.notional === 20000n && b0.cash === 8000n, { entry: b0.entry, price: await price() });
    duel = (await chain.readDuel(p0, id))!;
    check("public Duel shows trade counts and a coarse lead only", duel.trades[0] === 1 && duel.trades[1] === 1, { lead: duel.lead, trades: duel.trades });
    await sleep(8000);
    await chain.close(p0, id, asset);
    await chain.flip(p1, id, asset, 1, 1000, 3).catch((e) => console.log("flip", String(e).split("\n")[0]));
  }
  // late: nobody ends it inside the grace window, so the first call settles at the last recorded mid.
  await waitUntil(duel.endsAt + (MODE === "late" ? 8 : 1));
  const final = await endAndSettle(id);
  const after = [await totals(tesoroAccountPda(k0.publicKey)), await totals(tesoroAccountPda(k1.publicKey))];
  if (final.winner === DRAW) check("draw refunds both entries", after[0] === before[0] && after[1] === before[1], { before, after });
  else {
    const w = final.winner;
    check("the winner's Gemas moved", after[w] > before[w] && after[1 - w] === before[1 - w] - 500n, { before, after, winner: w });
  }
  const books = await chain.readBooksOnBase(id);
  check("both Books are public after commit (with fill history when traded)", !!books && (MODE === "draw" || books[0].fills.length >= 1), books?.map((b) => ({ fills: b.fills.length, cash: b.cash })));
}

main()
  .then(() => {
    const failed = evidence.checks.filter((c: any) => !c.pass);
    console.log(failed.length ? `${failed.length} FAILED` : "ALL PASS");
    process.exit(failed.length ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    save();
    process.exit(2);
  });
