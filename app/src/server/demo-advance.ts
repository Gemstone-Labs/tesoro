/**
 * Devnet SOL top-up for fees and rent (`fund`), and the server keys, chain helpers and nonce store shared with
 * /api/eth-bridge. Server only: the oracle and relayer keys are read from env secrets or disk here and never leave
 * this module.
 */
import "server-only";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { AnyProgram } from "@/games/block-puzzle/chain";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { baseRpc } from "@/lib/chain/rpc-config";
import { requireDevnet, requireTestMode } from "./cluster";
import { WindowLimiter, takeAll } from "./rate-limit";
import { solanaKeypair } from "./keys";
import { DemoHttpError, NonceStore, verifySignedRequest } from "./request-auth";

export { DemoHttpError };

export const BASE_RPC = baseRpc(process.env.TESORO_BASE_RPC);
const DAY = 24 * 60 * 60 * 1000;

const FUND_BELOW = 0.05 * LAMPORTS_PER_SOL;
const FUND_AMOUNT = 0.1 * LAMPORTS_PER_SOL;

const limits = {
  solPerAccount: new WindowLimiter(0.3 * LAMPORTS_PER_SOL, DAY),
  solPerUser: new WindowLimiter(0.3 * LAMPORTS_PER_SOL, DAY),
  solGlobal: new WindowLimiter(20 * LAMPORTS_PER_SOL, DAY),
};

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

// ---- entry point --------------------------------------------------------------------------------

export async function handleDemoRequest(raw: unknown, authorization: string | null): Promise<unknown> {
  requireTestMode();
  await requireDevnet(BASE_RPC);
  const req = await verifySignedRequest("tesoro-demo", ["fund"] as const, raw, authorization, { nonces });
  return fund(req.address, req.sub);
}
