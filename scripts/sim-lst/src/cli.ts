// Usage: tsx src/cli.ts rate | faucet | init | fund <sol>   (env: RPC_URL, KEYPAIR=~/.config/solana/id.json)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair } from "@solana/web3.js";
import { fundReserveInstruction, initializeInstruction, sendInstruction } from "./admin";
import { claimFaucet, readRate } from "./index";

const connection = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const cmd = process.argv[2];

function loadKeypair(): Keypair {
  const path = (process.env.KEYPAIR ?? "~/.config/solana/id.json").replace("~", homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

if (cmd === "rate") {
  const { rate, rateSol, pool } = await readRate(connection);
  console.log(
    `simSOL rate: ${rate} (${rateSol} SOL per simSOL) apy=${pool.apyBps}bps speedup=${pool.speedup}x [SIMULATED yield]`,
  );
} else if (cmd === "faucet") {
  console.log("faucet tx:", await claimFaucet(connection, loadKeypair()));
} else if (cmd === "init") {
  // apy 7%, default speedup (1 month = 10 min), faucet 10 simSOL per hour per user
  const admin = loadKeypair();
  const ix = initializeInstruction(admin.publicKey, 700, 4320, 10_000_000_000n, 3600n);
  console.log("init tx:", await sendInstruction(connection, admin, ix));
} else if (cmd === "fund") {
  const admin = loadKeypair();
  const sol = Number(process.argv[3] ?? "20");
  const ix = fundReserveInstruction(admin.publicKey, BigInt(Math.round(sol * 1e9)));
  console.log(`fund ${sol} SOL tx:`, await sendInstruction(connection, admin, ix));
} else {
  console.error("usage: cli.ts rate | faucet | init | fund <sol>");
  process.exit(1);
}
