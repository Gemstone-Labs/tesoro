/**
 * Simulated · demo Advance. TEMPORARY stopgap until Solana-native Position custody exists.
 *
 * For a signed-in Account this opens a SIMULATED Position with the oracle key and returns the
 * `take_advance` transaction (oracle-signed) for the Account to co-sign, so the Account receives
 * real on-chain Gemas. It can also send a little devnet SOL for fees. Server only: the oracle and
 * relayer keys are read from env secrets or disk here and never leave this module. See app/docs/demo-funding.md.
 */
import "server-only";
import { randomBytes } from "node:crypto";
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import nacl from "tweetnacl";
import { TESORO_CORE_PROGRAM_ID, BlockPuzzleChain, type AnyProgram } from "@/games/block-puzzle/chain";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { unitsToRepay, type SourceMath } from "@/lib/chain/ledger";
import { WindowLimiter, takeAll } from "./rate-limit";
import { solanaKeypair } from "./keys";

const BASE_RPC = process.env.TESORO_BASE_RPC ?? "https://rpc.magicblock.app/devnet";
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
  solGlobal: new WindowLimiter(20 * LAMPORTS_PER_SOL, DAY),
};

export class DemoHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---- keys ---------------------------------------------------------------------------------------

const keyCache = new Map<string, Keypair>();
/** From the env secret `secretVar`, else the keypair file (see ./keys). */
function loadKey(secretVar: string, fileVar: string, fallback: string): Keypair {
  const cached = keyCache.get(secretVar);
  if (cached) return cached;
  try {
    const kp = solanaKeypair(secretVar, fileVar, fallback);
    keyCache.set(secretVar, kp);
    return kp;
  } catch (e) {
    console.error(`[keys] ${secretVar}: ${(e as Error).message}`);
    throw new DemoHttpError(503, "not-configured", "Demo funding is not configured on this server.");
  }
}
export const oracleKey = () => loadKey("TESORO_ORACLE_SECRET_KEY", "TESORO_ORACLE_KEYPAIR", ".config/tesoro/oracle.json");
/** Fee payer and SOL faucet of the web routes: a low-balance key with no authority over any program or contract. */
export const relayerKey = () => loadKey("TESORO_RELAYER_SECRET_KEY", "TESORO_RELAYER_KEYPAIR", ".config/tesoro/relayer.json");
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

export type Step = "fund" | "advance" | "accrue";
export const message = (step: Step, address: string, ts: number) => `tesoro-demo|${step}|${address}|${ts}`;

const privyAppId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const devWallet = process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_DEV_WALLET === "1";
const jwks = privyAppId ? createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${privyAppId}/jwks.json`)) : null;

/**
 * Two proofs: the wallet signed a fresh message (it controls `address`), and, when Privy is
 * configured, a valid Privy access token (a signed-in Account). Returns the Privy user id, if any.
 */
export async function authenticateMessage(text: string, body: { address: string; ts: number; signature: string }, authorization: string | null) {
  const { address, ts, signature } = body;
  if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) throw new DemoHttpError(401, "stale", "Request expired. Try again.");
  let ok = false;
  try {
    ok = nacl.sign.detached.verify(new TextEncoder().encode(text), Buffer.from(signature, "base64"), new PublicKey(address).toBytes());
  } catch {
    ok = false;
  }
  if (!ok) throw new DemoHttpError(401, "bad-signature", "Wallet signature did not verify.");
  if (!jwks || devWallet) return null;
  const token = authorization?.replace(/^Bearer\s+/i, "");
  if (!token) throw new DemoHttpError(401, "signed-out", "Sign in to use the demo Advance.");
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: "privy.io", audience: privyAppId });
    return payload.sub ?? null;
  } catch {
    throw new DemoHttpError(401, "signed-out", "Sign in to use the demo Advance.");
  }
}

const authenticate = (body: { step: Step; address: string; ts: number; signature: string }, authorization: string | null) =>
  authenticateMessage(message(body.step, body.address, body.ts), body, authorization);

// ---- steps --------------------------------------------------------------------------------------

async function fund(address: PublicKey) {
  const { conn } = chain();
  const balance = await conn.getBalance(address);
  if (balance >= FUND_BELOW) return { funded: false, lamports: balance };
  const key = address.toBase58();
  const refund = takeAll([[limits.solPerAccount, key], [limits.solGlobal, "all"]], FUND_AMOUNT);
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
  if (!takeAll([[limits.advancePerAccount, key], ...(sub ? ([[limits.advancePerUser, sub]] as const) : []), [limits.advanceGlobal, "all"]])) {
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
  const body = raw as { step?: Step; address?: string; ts?: number; signature?: string; position?: string };
  if (!body || !["fund", "advance", "accrue"].includes(body.step ?? "") || !body.address || typeof body.ts !== "number" || !body.signature) {
    throw new DemoHttpError(400, "bad-request", "Malformed request.");
  }
  let address: PublicKey;
  try {
    address = new PublicKey(body.address);
  } catch {
    throw new DemoHttpError(400, "bad-request", "Malformed address.");
  }
  if (body.step !== "fund" && process.env.TESORO_DEMO_ADVANCE !== "1") {
    throw new DemoHttpError(410, "disabled", "The demo Advance is off. Open a real Position with simSOL instead.");
  }
  const sub = await authenticate({ step: body.step as Step, address: body.address, ts: body.ts, signature: body.signature }, authorization);
  switch (body.step) {
    case "fund":
      return fund(address);
    case "advance":
      return advance(address, sub);
    default:
      try {
        return await accrue(address, new PublicKey(body.position ?? ""));
      } catch (e) {
        if (e instanceof DemoHttpError) throw e;
        throw new DemoHttpError(400, "bad-request", "Malformed Position.");
      }
  }
}
