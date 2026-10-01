import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey, TransactionExpiredBlockheightExceededError } from "@solana/web3.js";
import { BlockPuzzleChain, keypairSigner } from "../../app/src/games/block-puzzle/chain.ts";
import { HoldemChain, keypairSigner as holdemSigner } from "../../app/src/games/holdem/chain.ts";
import { SplitConnection, type GpaFn } from "../../app/src/lib/chain/split-connection.ts";
import type { Settings } from "./env.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../..");
/** The app's IDL copies are the shared source; a fresh `target/idl` (from `anchor build`) wins when present. */
const idlDirs = [process.env.TESORO_IDL_DIR, join(repo, "target/idl")].filter((d): d is string => !!d);
const appIdlDir = join(repo, "app/src/lib/chain/idl");

/** IDL of a program: `target/idl` when built here, else the app's copy. */
export function loadIdl(name: string): any {
  for (const d of [...idlDirs, appIdlDir]) {
    const p = join(d, `${name}.json`);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  }
  throw new Error(`IDL ${name} not found`);
}

/** Whether the IDL we can see knows an instruction (i.e. the program was built with it). */
export const hasInstruction = (idl: any, name: string) => idl.instructions.some((i: any) => i.name === name);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Set when any RPC call saw a 429 since the last reset; the loop reads it to back off. */
export const rateLimit = { hits: 0 };

/** Each RPC request gives up after this, so a hung endpoint cannot stall a pass. */
const RPC_TIMEOUT_MS = Number(process.env.KEEPER_RPC_TIMEOUT_MS ?? 30_000);

/** fetch with a per-request timeout that retries 429s with exponential backoff (web3.js only retries a few times, quickly). */
export async function fetchWithBackoff(input: any, init?: any): Promise<Response> {
  for (let i = 0; ; i++) {
    const timeout = AbortSignal.timeout(RPC_TIMEOUT_MS);
    const res = await fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
    if (res.status !== 429 || i >= 5) return res;
    rateLimit.hits++;
    await sleep(1000 * 2 ** i);
  }
}

export interface Runtime {
  settings: Settings;
  conn: Connection;
  payer: Keypair;
  bp: BlockPuzzleChain;
  holdem: HoldemChain;
  signer: ReturnType<typeof keypairSigner>;
  hsigner: ReturnType<typeof holdemSigner>;
  core: BlockPuzzleChain["core"];
  coreIdl: any;
  /** Unix seconds of the cluster (the clock the programs use), not the local one. */
  now: number;
}

const connConfig = { commitment: "confirmed", fetch: fetchWithBackoff as typeof fetch, disableRetryOnRateLimit: true } as const;

type Statuses = Pick<Connection, "getSignatureStatuses" | "getBlockHeight">;
type Strategy = string | { signature: string; lastValidBlockHeight?: number };

/**
 * `confirmTransaction` by polling the signature status. web3.js waits on a websocket `signatureSubscribe`, which some
 * RPCs (Alchemy devnet) do not serve: a transaction that landed is then reported as expired and the caller sends it
 * again. Throws the same expiry error only once the blockhash really expired and the signature is still unknown.
 */
export async function pollConfirm(conn: Statuses, strategy: Strategy, pollMs = 1000, maxMs = 120_000) {
  const sig = typeof strategy === "string" ? strategy : strategy.signature;
  const lastValid = typeof strategy === "string" ? undefined : strategy.lastValidBlockHeight;
  const started = Date.now();
  for (;;) {
    const { context, value } = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const st = value[0];
    if (st && (st.err || st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { context, value: { err: st.err } };
    const expired = lastValid !== undefined ? (await conn.getBlockHeight("confirmed")) > lastValid : Date.now() - started > maxMs;
    if (expired && !st) throw new TransactionExpiredBlockheightExceededError(sig);
    await sleep(pollMs);
  }
}

/** Sends and single reads on `rpc`; getProgramAccounts on `gpaRpc`, shared for 5s (one loop asks for the same list many times). */
export function newConnection(rpc: string, gpaRpc: string = rpc): Connection {
  const gpaConn = new Connection(gpaRpc, connConfig);
  const seen = new Map<string, { at: number; p: Promise<any> }>();
  const gpa: GpaFn = (programId, config) => {
    const key = `${programId.toBase58()}:${JSON.stringify(config ?? {})}`;
    const hit = seen.get(key);
    if (hit && Date.now() - hit.at < 5000) return hit.p;
    const p = gpaConn.getProgramAccounts(programId, config as any) as Promise<any>;
    seen.set(key, { at: Date.now(), p });
    p.catch(() => seen.delete(key));
    return p;
  };
  const conn = new SplitConnection(rpc, gpa, connConfig);
  conn.confirmTransaction = ((strategy: Strategy) => pollConfirm(conn, strategy)) as Connection["confirmTransaction"];
  return conn;
}

export function buildRuntime(settings: Settings, conn: Connection, payer: Keypair): Runtime {
  const coreIdl = loadIdl("tesoro_core");
  const bp = new BlockPuzzleChain({ base: conn, blockPuzzleIdl: loadIdl("block_puzzle"), coreIdl });
  const holdem = new HoldemChain(loadIdl("holdem"), coreIdl, { base: conn });
  return { settings, conn, payer, bp, holdem, signer: keypairSigner(payer), hsigner: holdemSigner(payer), core: bp.core, coreIdl, now: 0 };
}

/** Cluster time, so deadline checks agree with the on-chain Clock. */
export async function clusterNow(conn: Connection): Promise<number> {
  const slot = await conn.getSlot("confirmed");
  return (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);
}

export const pk = (bytes: number[] | Uint8Array) => new PublicKey(Uint8Array.from(bytes));
