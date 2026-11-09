/**
 * Devnet check for seat keys user story 9: a Railcar step-off signed by the seat key alone, sent through the real sponsor
 * code in-process (the /api/sponsor routes' own handlers: request auth with the seat-key-signed request, the rules, the
 * Account and seat-key checks, build, admit, the relayer's co-signature, send). Staging's routes need a Privy session, so
 * the routes run here instead, with Privy off.
 *
 *   cd app && TESORO_RELAYER_KEYPAIR=<relayer keypair path> \
 *     NODE_OPTIONS="--dns-result-order=ipv4first --network-family-autoselection-attempt-timeout=3000" \
 *     ../keeper/node_modules/.bin/tsx --tsconfig tsconfig.json scripts/railcar-seat-step-off.mts <qa name> [--dry]
 *
 * The relayer key is read only by the route's own code, from TESORO_RELAYER_KEYPAIR or TESORO_RELAYER_SECRET_KEY; it must be
 * the relayer the on-chain SponsorState names, or the sponsor reports itself paused. The QA wallet (~/.cache/tesoro-tmp/qa/
 * devkeys.json) joins the car that is boarding, as the page boards (a seat key from the page's seat-key manager), then steps
 * off as the page does (`sendStepOff`). The wallet may not sign the step-off. Exits 1 unless the step-off transaction's
 * signers are exactly the relayer and the seat key. `--dry` sends nothing: it loads the routes and reads the car.
 * Usage counters live in memory (Supabase is switched off), so nothing is written to the prod database.
 */
import { Keypair, PublicKey, VersionedTransaction, type Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import Module, { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const name = process.argv[2];
const dry = process.argv.includes("--dry");
const fail = (m: string): never => {
  console.error(`FAIL ${m}`);
  process.exit(1);
};
if (!name) fail("usage: railcar-seat-step-off.mts <qa name> [--dry]");
if (!process.env.TESORO_RELAYER_KEYPAIR && !process.env.TESORO_RELAYER_SECRET_KEY) fail("set TESORO_RELAYER_KEYPAIR (a keypair path) or TESORO_RELAYER_SECRET_KEY");

// The routes' environment: Privy off (so the seat key's signature is the request's proof), counters in memory, devnet.
delete process.env.NEXT_PUBLIC_PRIVY_APP_ID;
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
if (process.env.NODE_ENV === "production") (process.env as Record<string, string>).NODE_ENV = "development";
process.env.TESORO_BASE_RPC ??= "https://rpc.magicblock.app/devnet";
process.env.NEXT_PUBLIC_SOLANA_RPC ??= process.env.TESORO_BASE_RPC;

// `import "server-only"` throws outside Next's server build: here it is an empty module.
const here = fileURLToPath(import.meta.url);
const serverOnly = fileURLToPath(new URL("./railcar-seat-step-off.server-only.cjs", import.meta.url));
const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
const resolve = M._resolveFilename;
M._resolveFilename = function (r: string, ...a: unknown[]) {
  return r === "server-only" ? serverOnly : resolve.call(this, r, ...a);
};

// One loader for the page code, the seat-key manager and the routes, so they share one seat-key manager and one chain client.
const req = createRequire(fileURLToPath(new URL("../src/games/railcar/useRailcar.ts", import.meta.url)));
const { seatKeys } = req("../../lib/seat/seat-key");
const { countingFor } = req("../../lib/seat/signature-counter");
const { getChain } = req("../../lib/chain/client");
const { sponsoredSend, sponsorStatus } = req("../../lib/chain/sponsor-client");
const { sendEntryTx, drawRemaining, readNextTicket, freshPot } = req("../../lib/chain/entry");
const { prepareEntryTicket } = req("../../lib/chain/ticket");
const { matchKeyOf } = req("../../lib/chain/match-id");
const { joinSeatIx, seatMarkPda } = req("../../lib/chain/many-seat");
const { loadCar } = req("../../lib/chain/many-seat-plan");
const { connReader } = req("../../lib/chain/settle-plan");
const { accountPda } = req("../../lib/chain/native");
const { ENTRY_GEMAS, RAILCAR_PROGRAM_ID, carPda, checkDepartureIx, configPda, decodeCarAccount, decodeConfig } = req("./chain");
const { boardingEntry } = req("./boarding");
const { queueChoice } = req("./flow");
const { boardingSigner, joinSeatKey } = req("./signers");
const { stepOffFor } = req("./step-off");
const { sendStepOff } = req("./step-off-send");
const routes: Record<string, { GET?: (r: Request) => Promise<Response>; POST?: (r: Request) => Promise<Response> }> = {
  "/api/sponsor": req("../../app/api/sponsor/route"),
  "/api/sponsor/build": req("../../app/api/sponsor/build/route"),
  "/api/sponsor/submit": req("../../app/api/sponsor/submit/route"),
};
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (typeof input === "string" && input.startsWith("/api/")) {
    const route = routes[input.split("?")[0]];
    if (!route) throw new Error(`no in-process route for ${input}`);
    const r = new Request(`http://local${input}`, init);
    return (init?.method ?? "GET") === "GET" ? route.GET!(r) : route.POST!(r);
  }
  return realFetch(input, init);
}) as typeof fetch;

const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${s}`);
const getToken = async () => null;
const kp = Keypair.fromSecretKey(bs58.decode((JSON.parse(readFileSync(`${process.env.HOME}/.cache/tesoro-tmp/qa/devkeys.json`, "utf8")) as Record<string, { sol: string }>)[name].sol));
// The QA wallet as the page's signer; it counts its signatures, and refuses any while `locked` (the step-off).
const signs = { n: 0, locked: false };
const countSign = () => {
  if (signs.locked) throw new Error("the wallet was asked to sign the step-off");
  signs.n += 1;
};
const wallet = {
  publicKey: kp.publicKey,
  signTransaction: async (tx: Transaction) => (countSign(), tx.partialSign(kp), tx),
  signSerialized: async (raw: Uint8Array) => {
    countSign();
    const tx = VersionedTransaction.deserialize(raw);
    tx.sign([kp]);
    return tx.serialize();
  },
  signMessage: async (m: Uint8Array) => (countSign(), nacl.sign.detached(m, kp.secretKey)),
};

const chain = getChain();
const read = connReader(chain.base);
const me: PublicKey = accountPda(kp.publicKey);
const status = await sponsorStatus();
const relayer = new PublicKey(status.relayer);
log(`code ${here}; relayer ${relayer.toBase58()} (sponsor ${status.paused ? "PAUSED" : "on"}); wallet ${name} ${kp.publicKey.toBase58()}`);
// The relayer core's SponsorState names (devnet G7zD…cTYP): the step-off's signers must be exactly it and the seat key.
const { sponsorPda } = req("../../lib/chain/basket");
const sponsorInfo = await chain.base.getAccountInfo(sponsorPda(), "confirmed");
const { BorshAccountsCoder } = req("@coral-xyz/anchor");
const named: PublicKey | null = sponsorInfo ? new PublicKey(new BorshAccountsCoder(req("../../lib/chain/idl/tesoro_core.json")).decode("SponsorState", sponsorInfo.data).relayer) : null;
log(`on-chain SponsorState relayer ${named?.toBase58() ?? "none"}`);
if (!dry && (!named || !named.equals(relayer))) fail(`the route's relayer ${relayer.toBase58()} is not the one the SponsorState names (${named?.toBase58()})`);
if (status.paused && !dry) fail("the sponsor reports itself paused: TESORO_RELAYER_KEYPAIR must be the relayer the on-chain SponsorState names");

// The car boarding now, read as the page reads it.
const [cfgInfo] = await read.many([configPda()]);
const config = decodeConfig(cfgInfo!.data);
const carNo: bigint = config.nextCar - 1n;
const [carInfo] = await read.many([carPda(carNo)]);
const loaded = carInfo ? await loadCar(read, decodeCarAccount(carInfo.data).tesoroMatch) : null;
if (!loaded || loaded.car.stage !== "boarding") fail(`no car is boarding (car ${carNo}): board 4 riders first`);
const seatedThere = loaded!.seats.some((s: { seated: boolean; player: PublicKey }) => s.seated && s.player.equals(me));
const choice = queueChoice({ config, boarding: { car: loaded!.car, carNo, pages: loaded!.pages }, now: Math.floor(Date.now() / 1000), mine: seatedThere, backerSeated: false });
if (choice.kind !== "join") fail(`the page would ${choice.kind}, not join car ${carNo} (seated ${loaded!.car.seated}): this check joins a waiting car`);
const match: PublicKey = choice.car;
const key: string = matchKeyOf({ opener: loaded!.car.opener.toBase58(), n: loaded!.car.n });
log(`car ${carNo} ${match.toBase58()} boarding, seated ${loaded!.car.seated}; ${name} joins`);
if (dry) {
  log("DRY: routes loaded, sponsor status and car read; nothing sent");
  process.exit(0);
}

// Boarding, as the page boards: the seat key co-signs, the wallet signs once, the relayer pays when it can.
countingFor(key);
const seatKey = await seatKeys().forMatch(key, kp.publicKey);
const { funder, preview } = await boardingEntry(chain.base, me);
const ticket = preview.needsTicket ? await prepareEntryTicket({ signer: wallet, seat: seatKey, getToken, game: RAILCAR_PROGRAM_ID, entry: BigInt(ENTRY_GEMAS), lines: preview.ticketLines }) : null;
const remaining = ticket ? [] : await drawRemaining(preview.plan);
const board = await sendEntryTx(boardingSigner(wallet, seatKey), getToken, async (payer: PublicKey, sponsored: boolean) => {
  const pot = ticket ? { address: ticket.address, nonce: ticket.nonce, lines: ticket.lineCap } : freshPot(funder, preview.potLines, await readNextTicket(funder));
  const join = joinSeatIx({ payer, player: kp.publicKey, car: match, game: RAILCAR_PROGRAM_ID, page: choice.page, pot, remaining, seatSigner: joinSeatKey(seatKey) });
  const { ComputeBudgetProgram } = req("@solana/web3.js");
  return [...(sponsored ? [] : [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]), join, checkDepartureIx(choice.carNo, match)];
});
log(`boarded ${board.sig} (${board.sponsored ? "sponsored" : "self-paid"}), wallet signatures so far ${signs.n}`);

// The step-off, as the page sends it: the seat key the seat names, through the sponsor; the wallet may not sign.
const seat = await seatKeys().find(key, kp.publicKey);
if (!seat) fail("the page's seat-key manager has no key for this car (two loaders?)");
const after = (await loadCar(read, match))!;
const mine = after.seats.find((s: { seated: boolean; player: PublicKey }) => s.seated && s.player.equals(me));
if (!mine) fail("the boarding did not seat the wallet");
if (!mine.signer.equals(seat.publicKey)) fail(`the seat names ${mine.signer.toBase58()}, not this page's seat key ${seat.publicKey.toBase58()}`);
const basket = async () => (await chain.base.getAccountInfo(PublicKey.findProgramAddressSync([Buffer.from("basket"), me.toBuffer()], chain.core.programId)[0], "confirmed"))?.data.readBigUInt64LE(48);
const before = await basket();
signs.locked = true;
let seatRefusal: unknown = null;
const sig: string = await sendStepOff({
  wallet,
  seat,
  seatSigner: mine.signer,
  build: (caller: PublicKey) => stepOffFor(chain.core, read, { caller, loaded: after, seat: mine }),
  sponsored: async (signer: { publicKey: PublicKey }, ixs: unknown[]) => {
    if (!signer.publicKey.equals(seat.publicKey)) fail(`the step-off fell back to the wallet; the seat key was refused: ${String(seatRefusal)}`);
    return sponsoredSend(signer, getToken, ixs).catch((e: unknown) => {
      seatRefusal = e;
      throw e;
    });
  },
  selfPaid: async () => fail(`the step-off fell back to the wallet paying; the seat key was refused: ${String(seatRefusal)}`),
}).catch((e: unknown) => fail(`step-off: ${e instanceof Error ? e.message : String(e)}`));

// What landed: its signers, the Gemas home, the seat mark gone.
let tx = null;
for (let i = 0; i < 20 && !tx; i++) {
  tx = await chain.base.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) await new Promise((r) => setTimeout(r, 1_000));
}
if (!tx) fail(`step-off ${sig} not found`);
const msg = tx!.transaction.message;
const signers = msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).map((k: PublicKey) => k.toBase58());
const want = [named!.toBase58(), seat.publicKey.toBase58()];
const mark = await chain.base.getAccountInfo(seatMarkPda(match, me), "confirmed");
log(`step-off ${sig} signers: ${signers.join(", ")}`);
log(`step-off ${sig}: err ${JSON.stringify(tx!.meta?.err ?? null)}, signers ${signers.map((k: string) => (k === want[0] ? "relayer" : k === want[1] ? "seat key" : k === kp.publicKey.toBase58() ? "WALLET" : k)).join(", ")}; basket ${before} -> ${await basket()} Gemas; seat mark ${mark ? "still there" : "closed"}; wallet signatures in the step-off 0 (boarding ${signs.n})`);
if (tx!.meta?.err) fail("the step-off failed on chain");
if (signers.length !== 2 || !want.every((k) => signers.includes(k))) fail(`signers are not exactly the relayer and the seat key: ${signers.join(", ")}`);
log(`PASS step-off ${sig} signed by the relayer ${want[0]} and the seat key ${want[1]} only`);
process.exit(0);
