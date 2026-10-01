/**
 * Simulated · demo Advance. TEMPORARY stopgap until Solana-native Position custody exists.
 *
 * For a signed-in Account this opens a SIMULATED Position with the oracle key and returns the
 * `take_advance` transaction (oracle-signed) for the Account to co-sign, so the Account receives
 * real on-chain Gemas. It can also send a little devnet SOL for fees. Server only: the oracle and
 * relayer keys are read from disk here and never leave this module. See app/docs/demo-funding.md.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TESORO_CORE_PROGRAM_ID, BlockPuzzleChain, type AnyProgram } from "@/games/block-puzzle/chain";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { unitsToRepay, type SourceMath } from "@/lib/chain/ledger";
import { DEFAULT_BASE_RPC } from "@/lib/chain/rpc-config";
import { requireDevnet } from "./cluster";
import { WindowLimiter, takeAll } from "./rate-limit";
import { DemoHttpError, NonceStore, verifySignedRequest } from "./request-auth";

export { DemoHttpError };

export const BASE_RPC = process.env.TESORO_BASE_RPC || DEFAULT_BASE_RPC;
const DAY = 24 * 60 * 60 * 1000;

/** The simulated Position: 10 SOL at 10% APY, 6-month Horizon, SOL at $150 = 7,500 Gemas. */
export const DEMO = {
  principalBaseUnits: 10n * BigInt(LAMPORTS_PER_SOL),
  rateBps: 1000,
  horizonMonths: 6,
  priceMicroUsd: 150_000_000n,
  gemas: 7500,
  /** Share of the Advance's Debt the simulated yield repays right away (redeemable now). */
  accruePercent: 20n,
};
const FUND_BELOW = 0.05 * LAMPORTS_PER_SOL;
const FUND_AMOUNT = 0.1 * LAMPORTS_PER_SOL;
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

const limits = {
  advancePerAccount: new WindowLimiter(3, DAY),
  advancePerUser: new WindowLimiter(5, DAY),
  advanceGlobal: new WindowLimiter(300, DAY),
  solPerAccount: new WindowLimiter(0.3 * LAMPORTS_PER_SOL, DAY),
  solPerUser: new WindowLimiter(0.3 * LAMPORTS_PER_SOL, DAY),
  solGlobal: new WindowLimiter(20 * LAMPORTS_PER_SOL, DAY),
};

// ---- keys ---------------------------------------------------------------------------------------

const keyCache = new Map<string, Keypair>();
function loadKey(envVar: string, fallback: string): Keypair {
  const file = process.env[envVar] ?? path.join(os.homedir(), fallback);
  const cached = keyCache.get(file);
  if (cached) return cached;
  try {
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
    keyCache.set(file, kp);
    return kp;
  } catch {
    throw new DemoHttpError(503, "not-configured", "Demo funding is not configured on this server.");
  }
}
export const oracleKey = () => loadKey("TESORO_ORACLE_KEYPAIR", ".config/tesoro/oracle.json");
/** Fee payer and SOL faucet of the web routes: a low-balance key with no authority over any program or contract. */
export const relayerKey = () => loadKey("TESORO_RELAYER_KEYPAIR", ".config/tesoro/relayer.json");
/** The relayer keeps at least this much SOL. */
export const RELAYER_MIN_LAMPORTS = 0.5 * LAMPORTS_PER_SOL;

// ---- chain --------------------------------------------------------------------------------------

let conn: Connection | null = null;
let core: AnyProgram | null = null;
export function chain() {
  if (!conn || !core) {
    conn = new Connection(BASE_RPC, "confirmed");
    const provider = new AnchorProvider(
      conn,
      { publicKey: Keypair.generate().publicKey, signTransaction: async (t: never) => t, signAllTransactions: async (t: never) => t },
      { commitment: "confirmed" },
    );
    core = new Program(coreIdl as Idl, provider) as unknown as AnyProgram;
  }
  return { conn, core };
}

export async function sendAndConfirm(tx: Transaction, signers: Keypair[]): Promise<string> {
  const { conn } = chain();
  tx.feePayer = signers[0].publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  for (let i = 0; i < 60; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") {
      if (st.err) throw new DemoHttpError(502, "chain", `Transaction failed: ${JSON.stringify(st.err)}`);
      return sig;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new DemoHttpError(504, "timeout", "Transaction was not confirmed in time.");
}

// ---- request authentication -----------------------------------------------------------------------

/** Single-use nonces of /api/demo-advance and /api/eth-bridge (one store: both share the 5-min window). */
export const nonces = new NonceStore();

/** Per-user quota claim: the verified Privy user id, when there is one (always in production). */
export const perUser = (limiter: WindowLimiter, sub: string | null) => (sub ? ([[limiter, sub]] as const) : []);

// ---- steps --------------------------------------------------------------------------------------

async function fund(address: PublicKey, sub: string | null) {
  const { conn } = chain();
  const balance = await conn.getBalance(address);
  if (balance >= FUND_BELOW) return { funded: false, lamports: balance };
  const key = address.toBase58();
  const refund = takeAll([[limits.solPerAccount, key], ...perUser(limits.solPerUser, sub), [limits.solGlobal, "all"]], FUND_AMOUNT);
  if (!refund) throw new DemoHttpError(429, "rate-limited", "Demo SOL limit reached for this Account. Try again tomorrow.");
  const relayer = relayerKey();
  if ((await conn.getBalance(relayer.publicKey)) < RELAYER_MIN_LAMPORTS + FUND_AMOUNT) {
    refund();
    throw new DemoHttpError(503, "faucet-empty", "The demo faucet is empty.");
  }
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: relayer.publicKey, toPubkey: address, lamports: FUND_AMOUNT }));
  const signature = await sendAndConfirm(tx, [relayer]);
  return { funded: true, lamports: balance + FUND_AMOUNT, signature };
}

async function advance(address: PublicKey, sub: string | null) {
  const { core } = chain();
  const oracle = oracleKey();
  const account = BlockPuzzleChain.coreAccount(address);
  if (!(await core.account.tesoroAccount.fetchNullable(account))) {
    throw new DemoHttpError(409, "account-missing", "Create your Account first.");
  }
  const key = address.toBase58();
  if (!takeAll([[limits.advancePerAccount, key], ...perUser(limits.advancePerUser, sub), [limits.advanceGlobal, "all"]])) {
    throw new DemoHttpError(429, "rate-limited", "Demo Advance limit reached for this Account. Try again tomorrow.");
  }

  const positionId = Array.from(randomBytes(32));
  const config = BlockPuzzleChain.addresses(0n).config;
  const position = PublicKey.findProgramAddressSync([Buffer.from("position"), Buffer.from([0]), Buffer.from(positionId)], TESORO_CORE_PROGRAM_ID)[0];
  const source = PublicKey.findProgramAddressSync([Buffer.from("source"), position.toBuffer(), new BN(0).toArrayLike(Buffer, "le", 4)], TESORO_CORE_PROGRAM_ID)[0];
  const holding = BlockPuzzleChain.holding(account, source);

  const open = await core.methods
    .openPosition({ solana: {} }, positionId, NATIVE_MINT, 9, new BN(DEMO.principalBaseUnits.toString()), DEMO.rateBps)
    .accountsPartial({ oracle: oracle.publicKey, config, ownerAccount: account, position, systemProgram: SystemProgram.programId })
    .instruction();
  const openSig = await sendAndConfirm(new Transaction().add(open), [oracle]);

  const take = await core.methods
    .takeAdvance(DEMO.horizonMonths, new BN(DEMO.priceMicroUsd.toString()))
    .accountsPartial({ oracle: oracle.publicKey, ownerAuthority: address, config, ownerAccount: account, position, source, holding, systemProgram: SystemProgram.programId })
    .instruction();
  const tx = new Transaction().add(take);
  tx.feePayer = oracle.publicKey;
  tx.recentBlockhash = (await chain().conn.getLatestBlockhash()).blockhash;
  tx.partialSign(oracle);
  return {
    position: position.toBase58(),
    source: source.toBase58(),
    gemas: DEMO.gemas,
    openSig,
    transaction: tx.serialize({ requireAllSignatures: false }).toString("base64"),
  };
}

/** Simulated yield: repays a slice of the Advance's Debt so part of the Gemas are redeemable. Once per Position. */
async function accrue(address: PublicKey, positionKey: PublicKey) {
  const { core } = chain();
  const oracle = oracleKey();
  const account = BlockPuzzleChain.coreAccount(address);
  const pos: any = await core.account.positionState.fetchNullable(positionKey);
  if (!pos || new PublicKey(pos.inner.owner).toBase58() !== account.toBase58()) {
    throw new DemoHttpError(403, "not-yours", "That Position is not yours.");
  }
  if (pos.inner.openAdvance === null || pos.inner.openAdvance === undefined) return { skipped: true };
  const source = PublicKey.findProgramAddressSync(
    [Buffer.from("source"), positionKey.toBuffer(), new BN(pos.inner.openAdvance).toArrayLike(Buffer, "le", 4)],
    TESORO_CORE_PROGRAM_ID,
  )[0];
  const src: any = await core.account.sourceState.fetch(source);
  const big = (n: { toString(): string }) => BigInt(n.toString());
  const math: SourceMath = {
    issued: big(src.inner.issued),
    returned: big(src.inner.returned),
    redeemed: big(src.inner.redeemed),
    yieldUnits: big(src.inner.yieldUnits),
    unitNum: big(src.inner.unitNum),
    unitDen: big(src.inner.unitDen),
  };
  if (math.yieldUnits > 0n) return { skipped: true };
  const delta = (unitsToRepay(math) * DEMO.accruePercent) / 100n;
  const ix = await core.methods
    .applyYield(new BN(big(pos.inner.lastSeq) + 1n), new BN((big(pos.inner.cumulativeYield) + delta).toString()))
    .accountsPartial({ oracle: oracle.publicKey, config: BlockPuzzleChain.addresses(0n).config, position: positionKey, source })
    .instruction();
  const signature = await sendAndConfirm(new Transaction().add(ix), [oracle]);
  return { skipped: false, signature };
}

// ---- entry point --------------------------------------------------------------------------------

export async function handleDemoRequest(raw: unknown, authorization: string | null): Promise<unknown> {
  const step = (raw as { step?: unknown } | null)?.step;
  if ((step === "advance" || step === "accrue") && process.env.TESORO_DEMO_ADVANCE !== "1") {
    throw new DemoHttpError(410, "disabled", "The demo Advance is off. Open a real Position with simSOL instead.");
  }
  await requireDevnet(BASE_RPC);
  const req = await verifySignedRequest("tesoro-demo", ["fund", "advance", "accrue"] as const, raw, authorization, { nonces });
  switch (req.step) {
    case "fund":
      return fund(req.address, req.sub);
    case "advance":
      return advance(req.address, req.sub);
    default:
      try {
        return await accrue(req.address, new PublicKey(String(req.fields.position ?? "")));
      } catch (e) {
        if (e instanceof DemoHttpError) throw e;
        throw new DemoHttpError(400, "bad-request", "Malformed Position.");
      }
  }
}
