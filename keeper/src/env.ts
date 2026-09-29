import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";

export interface Settings {
  rpc: string;
  keypairPath: string;
  deployerPath: string;
  intervalMs: number;
  once: boolean;
  /** Max lamports the keeper payer may spend (fees + rent) in any rolling hour. */
  hourlyCapLamports: number;
  /** Simulated: report what would be done, send nothing. */
  dryRun: boolean;
}

export function settings(argv = process.argv.slice(2), env = process.env): Settings {
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (v: string | undefined, d: number) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    rpc: value("rpc") ?? env.KEEPER_RPC ?? "https://rpc.magicblock.app/devnet",
    keypairPath: env.KEEPER_KEYPAIR ?? join(homedir(), ".config/tesoro/keeper.json"),
    deployerPath: env.KEEPER_FUNDER ?? join(homedir(), ".config/solana/id.json"),
    intervalMs: num(value("interval") ?? env.KEEPER_INTERVAL_SECS, 20) * 1000,
    once: flag("once"),
    hourlyCapLamports: Math.round(num(value("max-sol-per-hour") ?? env.KEEPER_MAX_SOL_PER_HOUR, 0.5) * LAMPORTS_PER_SOL),
    dryRun: flag("dry-run"),
  };
}

const readKeypair = (path: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));

/** The keeper's payer: created on first run and funded with 2 devnet SOL from the deployer. Never committed. */
export async function loadPayer(conn: Connection, s: Settings, log: (m: string) => void): Promise<Keypair> {
  let payer: Keypair;
  if (existsSync(s.keypairPath)) {
    payer = readKeypair(s.keypairPath);
  } else {
    mkdirSync(dirname(s.keypairPath), { recursive: true });
    payer = Keypair.generate();
    writeFileSync(s.keypairPath, JSON.stringify(Array.from(payer.secretKey)), { mode: 0o600 });
    log(`wallet created ${payer.publicKey.toBase58()} at ${s.keypairPath}`);
  }
  const balance = await conn.getBalance(payer.publicKey);
  if (balance === 0 && existsSync(s.deployerPath) && !s.dryRun) {
    const funder = readKeypair(s.deployerPath);
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: payer.publicKey, lamports: 2 * LAMPORTS_PER_SOL }),
    );
    const sig = await sendAndConfirmTransaction(conn, tx, [funder], { commitment: "confirmed" });
    log(`wallet funded 2 SOL from ${funder.publicKey.toBase58()} ${sig}`);
  }
  return payer;
}

export const shortKey = (k: PublicKey | string) => {
  const s = typeof k === "string" ? k : k.toBase58();
  return `${s.slice(0, 4)}..${s.slice(-4)}`;
};
