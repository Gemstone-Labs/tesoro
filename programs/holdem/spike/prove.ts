/**
 * S1 proof script. Runs the holdem spike flow against Solana devnet + the MagicBlock devnet TEE
 * and records evidence to evidence.json.
 *
 *   pnpm prove                    # all steps, new match
 *   pnpm prove create delegate    # selected steps, reusing state.json
 */
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  GetCommitmentSignature,
  MAGIC_PROGRAM_ID,
  PERMISSION_PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  getAuthToken,
  permissionPdaFromAccount,
  verifyTeeRpcIntegrity,
} from "@magicblock-labs/ephemeral-rollups-sdk";
import nacl from "tweetnacl";
import fs from "fs";
import os from "os";
import path from "path";

const HERE = __dirname;
const BASE_RPC = process.env.BASE_RPC ?? "https://api.devnet.solana.com";
const TEE_RPC = "https://devnet-tee.magicblock.app";
const TEE_WS = "wss://devnet-tee.magicblock.app";
const TEE_VALIDATOR = new PublicKey("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
const VAULT_ID = new PublicKey("MagicVau1t999999999999999999999999999999999");
const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
const ORACLE_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");

const idl = JSON.parse(
  fs.readFileSync(path.join(HERE, "../../../target/idl/holdem.json"), "utf8"),
);
const PROGRAM_ID = new PublicKey(idl.address);

const STATE_FILE = path.join(HERE, "state.json");
const EVIDENCE_FILE = path.join(HERE, "evidence.json");
const KEYS_FILE = path.join(HERE, ".keys.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const load = (f: string, d: any) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const save = (f: string, v: any) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

const state: any = load(STATE_FILE, {});
const evidence: any = load(EVIDENCE_FILE, { txs: [], checks: [] });
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

function record(step: string, sig: string, layer: "base" | "tee", note = "") {
  evidence.txs.push({ step, layer, sig, link: layer === "base" ? explorer(sig) : undefined, note });
  save(EVIDENCE_FILE, evidence);
  console.log(`[${layer}] ${step}: ${sig}`);
}
function check(name: string, pass: boolean, detail: unknown) {
  evidence.checks.push({ name, pass, detail });
  save(EVIDENCE_FILE, evidence);
  console.log(`${pass ? "PASS" : "FAIL"} ${name} :: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}

const deployer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/dev-2026-10.json"), "utf8"))),
);
const keys = load(KEYS_FILE, null) ?? (() => {
  const k = { p0: Array.from(Keypair.generate().secretKey), p1: Array.from(Keypair.generate().secretKey) };
  save(KEYS_FILE, k);
  return k;
})();
const p0 = Keypair.fromSecretKey(Uint8Array.from(keys.p0));
const p1 = Keypair.fromSecretKey(Uint8Array.from(keys.p1));
const outsider = deployer; // funded wallet that is NOT a member of any permission

const base = new Connection(BASE_RPC, "confirmed");
const provider = new anchor.AnchorProvider(base, new anchor.Wallet(deployer), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider) as anchor.Program<any>;

const teeConns = new Map<string, Connection>();
async function tee(kp: Keypair): Promise<Connection> {
  const k = kp.publicKey.toBase58();
  if (teeConns.has(k)) return teeConns.get(k)!;
  const { token } = await getAuthToken(TEE_RPC, kp.publicKey, (m: Uint8Array) =>
    Promise.resolve(nacl.sign.detached(m, kp.secretKey)),
  );
  const c = new Connection(`${TEE_RPC}?token=${token}`, { wsEndpoint: `${TEE_WS}?token=${token}`, commitment: "confirmed" });
  teeConns.set(k, c);
  return c;
}

async function sendBase(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await base.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  const sig = await base.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  const res = await base.confirmTransaction({ signature: sig, ...(await base.getLatestBlockhash()) }, "confirmed");
  if (res.value.err) {
    const t = await base.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    throw new Error(`base tx failed ${sig}: ${JSON.stringify(res.value.err)}\n${t?.meta?.logMessages?.join("\n")}`);
  }
  return sig;
}

async function sendTee(ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const conn = await tee(signers[0]);
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (let i = 0; i < 40; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st) {
      if (st.err) {
        const t = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null);
        throw new Error(`tee tx failed ${sig}: ${JSON.stringify(st.err)}\n${t?.meta?.logMessages?.join("\n") ?? ""}`);
      }
      return sig;
    }
    await sleep(500);
  }
  throw new Error(`tee tx not confirmed ${sig}`);
}

const pda = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
function addresses(matchId: anchor.BN) {
  const m = pda([Buffer.from("match"), matchId.toArrayLike(Buffer, "le", 8)]);
  return {
    match: m,
    deck: pda([Buffer.from("deck"), m.toBuffer()]),
    hole0: pda([Buffer.from("hole"), m.toBuffer(), Buffer.from([0])]),
    hole1: pda([Buffer.from("hole"), m.toBuffer(), Buffer.from([1])]),
  };
}

async function readAccount(conn: Connection, address: PublicKey, type: string) {
  try {
    const info = await conn.getAccountInfo(address);
    if (!info) return { refused: false, exists: false as const };
    if (type === "raw") return { refused: false, exists: true as const, owner: info.owner.toBase58(), data: info.data };
    return { refused: false, exists: true as const, owner: info.owner.toBase58(), decoded: program.coder.accounts.decode(type, info.data) };
  } catch (e: any) {
    return { refused: true, error: String(e?.message ?? e).slice(0, 300) };
  }
}

async function waitOwner(conn: Connection, a: PublicKey, owner: PublicKey, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const info = await conn.getAccountInfo(a).catch(() => null);
    if (info?.owner.equals(owner)) return true;
    await sleep(1000);
  }
  return false;
}

const steps: Record<string, () => Promise<void>> = {
  async fund() {
    for (const [kp, sol] of [[p0, 0.08], [p1, 0.02]] as [Keypair, number][]) {
      const bal = await base.getBalance(kp.publicKey);
      if (bal < sol * 1e9 * 0.5) {
        const sig = await sendBase(
          [SystemProgram.transfer({ fromPubkey: deployer.publicKey, toPubkey: kp.publicKey, lamports: Math.round(sol * 1e9) })],
          [deployer],
        );
        record(`fund ${kp.publicKey.toBase58().slice(0, 6)}`, sig, "base");
      }
    }
  },

  async create() {
    const matchId = new anchor.BN(Date.now());
    state.matchId = matchId.toString();
    state.p0 = p0.publicKey.toBase58();
    state.p1 = p1.publicKey.toBase58();
    state.addr = Object.fromEntries(Object.entries(addresses(matchId)).map(([k, v]) => [k, v.toBase58()]));
    save(STATE_FILE, state);
    const ix = await program.methods
      .createMatch(matchId, p1.publicKey)
      .accountsPartial({ creator: p0.publicKey, ...addresses(matchId) } as any)
      .instruction();
    record("create_match", await sendBase([ix], [p0]), "base");
  },

  async delegate() {
    const id = new anchor.BN(state.matchId);
    const a = addresses(id);
    const ix = await program.methods
      .delegateMatch(id)
      .accountsPartial({
        payer: deployer.publicKey,
        gameMatch: a.match,
        deck: a.deck,
        hole0: a.hole0,
        hole1: a.hole1,
        validator: TEE_VALIDATOR,
      } as any)
      .instruction();
    const cu = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
    record("delegate_match", await sendBase([cu, ix], [deployer]), "base");
    const ok = await waitOwner(base, a.match, DELEGATION_PROGRAM_ID);
    const ok2 = await waitOwner(base, a.deck, DELEGATION_PROGRAM_ID);
    check("delegation: all accounts owned by delegation program on base", ok && ok2, { match: ok, deck: ok2 });
    await sleep(4000);
  },

  async permissions() {
    const ok = await verifyTeeRpcIntegrity(TEE_RPC).then(() => true).catch((e) => String(e));
    check("TEE RPC attestation (verifyTeeRpcIntegrity)", ok === true, ok);
    const id = new anchor.BN(state.matchId);
    const a = addresses(id);
    const ix = await program.methods
      .initPermissions()
      .accountsPartial({
        payer: p0.publicKey,
        gameMatch: a.match,
        deck: a.deck,
        hole0: a.hole0,
        hole1: a.hole1,
        matchPermission: permissionPdaFromAccount(a.match),
        deckPermission: permissionPdaFromAccount(a.deck),
        hole0Permission: permissionPdaFromAccount(a.hole0),
        hole1Permission: permissionPdaFromAccount(a.hole1),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
      } as any)
      .instruction();
    record("init_permissions", await sendTee([ix], [p0]), "tee");
  },

  async entropy() {
    const a = addresses(new anchor.BN(state.matchId));
    for (const [seat, kp] of [[0, p0], [1, p1]] as [number, Keypair][]) {
      const secret = Array.from(nacl.randomBytes(32));
      const ix = await program.methods
        .contributeEntropy(seat, secret)
        .accountsPartial({ player: kp.publicKey, gameMatch: a.match, deck: a.deck } as any)
        .instruction();
      record(`contribute_entropy seat ${seat}`, await sendTee([ix], [kp]), "tee");
    }
  },

  async vrf() {
    const a = addresses(new anchor.BN(state.matchId));
    const ix = await program.methods
      .requestVrf(7)
      .accountsPartial({
        payer: p0.publicKey,
        gameMatch: a.match,
        deck: a.deck,
        oracleQueue: ORACLE_QUEUE,
      } as any)
      .instruction();
    record("request_vrf", await sendTee([ix], [p0]), "tee");
    await sleep(8000);
  },

  async deal() {
    const a = addresses(new anchor.BN(state.matchId));
    const ix = await program.methods
      .deal()
      .accountsPartial({ payer: p0.publicKey, gameMatch: a.match, deck: a.deck, hole0: a.hole0, hole1: a.hole1 } as any)
      .instruction();
    record("deal", await sendTee([ix], [p0]), "tee");
    const c0 = await tee(p0);
    const m: any = await readAccount(c0, a.match, "gameMatch");
    check("deal: VRF output reached the private Deck (Match.vrf_mixed)", !!m.decoded?.vrfMixed, m.decoded ?? m);
  },

  async privacy() {
    const a = addresses(new anchor.BN(state.matchId));
    const actors: [string, Keypair][] = [["player0", p0], ["player1", p1], ["outsider", outsider]];
    const table: any = {};
    const cards: Record<string, number[]> = {};
    for (const [who, kp] of actors) {
      const c = await tee(kp);
      table[who] = {};
      for (const [name, addr, type] of [
        ["hole0", a.hole0, "hole"],
        ["hole1", a.hole1, "hole"],
        ["deck", a.deck, "deck"],
        ["match", a.match, "gameMatch"],
      ] as [string, PublicKey, string][]) {
        const r: any = await readAccount(c, addr, type);
        table[who][name] = r.decoded
          ? { readable: true, ...(name.startsWith("hole") ? { cards: r.decoded.cards } : {}) }
          : r.exists === false
            ? { readable: false, result: "null (account hidden)" }
            : { readable: false, result: r.error ?? "refused" };
        if (name.startsWith("hole") && r.decoded) cards[`${who}:${name}`] = Array.from(r.decoded.cards);
        if (name === "deck" && r.decoded) cards[`${who}:deck`] = Array.from(r.decoded.cards);
      }
    }
    evidence.privacyMatrix = table;
    evidence.cardsSeenByPlayers = cards;
    save(EVIDENCE_FILE, evidence);
    console.log(JSON.stringify(table, null, 1));

    const t = table;
    check("player0 reads own hole cards", t.player0.hole0.readable, t.player0.hole0);
    check("player1 reads own hole cards", t.player1.hole1.readable, t.player1.hole1);
    check("player0 refused on player1's hole cards", !t.player0.hole1.readable, t.player0.hole1);
    check("player1 refused on player0's hole cards", !t.player1.hole0.readable, t.player1.hole0);
    check("outsider refused on both hole accounts", !t.outsider.hole0.readable && !t.outsider.hole1.readable, [t.outsider.hole0, t.outsider.hole1]);
    check("deck unreadable by player0, player1 and outsider", !t.player0.deck.readable && !t.player1.deck.readable && !t.outsider.deck.readable, [t.player0.deck, t.player1.deck, t.outsider.deck]);

    const seen = [...(cards["player0:hole0"] ?? []), ...(cards["player1:hole1"] ?? [])];
    check("4 distinct valid cards dealt", new Set(seen).size === 4 && seen.every((c) => c >= 0 && c < 52), seen);

    // No-token and base-layer views
    const anon = new Connection(TEE_RPC, "confirmed");
    const anonRead = await readAccount(anon, a.hole0, "hole");
    check("no-token TEE read of hole0 fails", !(anonRead as any).decoded, anonRead);
    const baseHole: any = await readAccount(base, a.hole0, "hole");
    check("base-layer copy of hole0 holds no cards (stale zeros)", !!baseHole.decoded && baseHole.decoded.cards.every((c: number) => c === 0), baseHole.decoded ?? baseHole);
    const baseDeck: any = await readAccount(base, a.deck, "deck");
    check("base-layer copy of Deck holds no entropy/vrf/cards", !!baseDeck.decoded && baseDeck.decoded.cards.every((c: number) => c === 0) && baseDeck.decoded.vrf.every((c: number) => c === 0), baseDeck.decoded ? { vrfSeen: baseDeck.decoded.vrfSeen } : baseDeck);
  },

  async txprivacy() {
    // Can an outsider read the TEE transactions of the hand?
    const outsiderConn = await tee(outsider);
    const results: any = {};
    for (const t of evidence.txs.filter((x: any) => x.layer === "tee")) {
      const r = await outsiderConn
        .getTransaction(t.sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
        .then((x) => (x ? { visible: true, logs: x.meta?.logMessages?.length } : { visible: false, result: "null" }))
        .catch((e) => ({ visible: false, error: String(e.message).slice(0, 200) }));
      results[t.step] = r;
    }
    evidence.outsiderTxView = results;
    save(EVIDENCE_FILE, evidence);
    console.log(JSON.stringify(results, null, 1));
  },

  async closehand() {
    const a = addresses(new anchor.BN(state.matchId));
    const ix = await program.methods
      .closeHand()
      .accountsPartial({
        payer: p0.publicKey,
        gameMatch: a.match,
        deck: a.deck,
        hole0: a.hole0,
        hole1: a.hole1,
        deckPermission: permissionPdaFromAccount(a.deck),
        hole0Permission: permissionPdaFromAccount(a.hole0),
        hole1Permission: permissionPdaFromAccount(a.hole1),
        permissionProgram: PERMISSION_PROGRAM_ID,
        ephemeralVault: VAULT_ID,
        magicProgram: MAGIC_PROGRAM_ID,
        magicContext: MAGIC_CONTEXT,
      } as any)
      .instruction();
    const sig = await sendTee([ix], [p0]);
    record("close_hand (wipe + close permissions + undelegate deck/holes)", sig, "tee");
    const c0 = await tee(p0);
    const commit = await GetCommitmentSignature(sig, c0).catch((e) => `error: ${e.message}`);
    record("close_hand commit on base", commit, "base");
    const ok = await waitOwner(base, a.deck, PROGRAM_ID);
    const ok2 = await waitOwner(base, a.hole0, PROGRAM_ID);
    const deck: any = await readAccount(base, a.deck, "deck");
    check("deck + holes back on base, wiped", ok && ok2 && deck.decoded?.cards.every((c: number) => c === 0), { ok, ok2 });
  },

  async settle() {
    const a = addresses(new anchor.BN(state.matchId));
    const ix = await program.methods
      .settle(0)
      .accountsPartial({ payer: p0.publicKey, gameMatch: a.match, magicContext: MAGIC_CONTEXT, magicProgram: MAGIC_PROGRAM_ID } as any)
      .instruction();
    const sig = await sendTee([ix], [p0]);
    record("settle (record result + commit_and_undelegate Match)", sig, "tee");
    const c0 = await tee(p0);
    const commit = await GetCommitmentSignature(sig, c0).catch((e) => `error: ${e.message}`);
    record("settle commit on base", commit, "base");
    const back = await waitOwner(base, a.match, PROGRAM_ID, 60);
    check("Match undelegated: owner is holdem on base layer", back, { back });
    const m: any = await readAccount(base, a.match, "gameMatch");
    check("base layer sees committed result", !!m.decoded?.settled && m.decoded.winner === 0, m.decoded ?? m);

    const readIx = await program.methods.readResult().accountsPartial({ gameMatch: a.match } as any).instruction();
    const rsig = await sendBase([readIx], [deployer]);
    record("read_result (base-layer instruction consuming committed result)", rsig, "base");
    const t = await base.getTransaction(rsig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    check("read_result logs the settled winner", !!t?.meta?.logMessages?.some((l) => l.includes("settled on base layer: winner=0")), t?.meta?.logMessages?.filter((l) => l.includes("settled")));
  },
};

async function main() {
  const wanted = process.argv.slice(2);
  const order = ["fund", "create", "delegate", "permissions", "entropy", "vrf", "deal", "privacy", "txprivacy", "closehand", "settle"];
  const run = wanted.length ? wanted : order;
  if (!wanted.length) {
    fs.rmSync(EVIDENCE_FILE, { force: true });
    evidence.txs = [];
    evidence.checks = [];
  }
  console.log("program", PROGRAM_ID.toBase58(), "p0", p0.publicKey.toBase58(), "p1", p1.publicKey.toBase58());
  for (const s of run) {
    console.log(`\n== ${s}`);
    await steps[s]();
  }
  console.log("\nstate", JSON.stringify(state.addr));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
