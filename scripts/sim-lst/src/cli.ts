// Usage: tsx src/cli.ts rate | faucet   (env: RPC_URL, KEYPAIR=~/.config/solana/id.json)
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair } from "@solana/web3.js";
import { claimFaucet, readRate } from "./index";

const connection = new Connection(process.env.RPC_URL ?? "https://api.devnet.solana.com", "confirmed");
const cmd = process.argv[2];

if (cmd === "rate") {
  const { rate, rateSol, pool } = await readRate(connection);
  console.log(
    `simSOL rate: ${rate} (${rateSol} SOL per simSOL) apy=${pool.apyBps}bps speedup=${pool.speedup}x [SIMULATED yield]`,
  );
} else if (cmd === "faucet") {
  const path = (process.env.KEYPAIR ?? "~/.config/solana/id.json").replace("~", homedir());
  const user = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
  console.log("faucet tx:", await claimFaucet(connection, user));
} else {
  console.error("usage: cli.ts rate | faucet");
  process.exit(1);
}
