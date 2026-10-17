// Usage: tsx src/cli.ts <cmd> [args]
//   faucet | account | price <usd> | open <simSOL> <months> | status | crank | redeem | unlock | sweep
// env: RPC_URL (default: the test cluster RPC in app/src/lib/cluster-settings.ts), KEYPAIR (~/.config/solana/dev-2026-10.json),
//      NONCE (default 1), ORACLE_KEYPAIR (~/.config/tesoro/oracle.json, for `price`).
// Everything here is SIMULATED yield on devnet: 1 month = ~10 min.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Connection, Keypair } from "@solana/web3.js";
import * as n from "./index";
import { CLUSTERS } from "../../../app/src/lib/cluster-settings";

const c = new Connection(process.env.RPC_URL ?? CLUSTERS.test.solana.defaultRpc!, "confirmed");
const load = (p: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p.replace("~", homedir()), "utf8"))));
const user = load(process.env.KEYPAIR ?? "~/.config/solana/dev-2026-10.json");
const nonce = BigInt(process.env.NONCE ?? "1");
const position = n.positionPda(user.publicKey, nonce);
const [cmd, a1, a2] = process.argv.slice(2);

async function status() {
  const p = await n.readPosition(c, position);
  console.log("position", position.toBase58(), p);
  if (p && p.advances > 0) {
    console.log("latest advance", await n.readSource(c, n.sourcePda(position, p.advances - 1)));
  }
  console.log("rate", await n.readRate(c), "wallet simSOL", await n.simSolBalance(c, user.publicKey));
}

switch (cmd) {
  case "faucet":
    console.log("faucet:", await n.send(c, user, [n.faucetIx(user.publicKey)]));
    break;
  case "account":
    console.log("account:", await n.ensureAccount(c, user));
    break;
  case "price": {
    const oracle = load(process.env.ORACLE_KEYPAIR ?? "~/.config/tesoro/oracle.json");
    const micro = BigInt(Math.round(Number(a1 ?? "150") * 1e6));
    console.log("set_price:", await n.send(c, oracle, [n.setPriceIx(oracle.publicKey, micro)]));
    break;
  }
  case "open": {
    const shares = BigInt(Math.round(Number(a1 ?? "1") * 1e9));
    console.log("open+advance:", await n.openWithAdvance(c, user, nonce, shares, Number(a2 ?? "1")));
    break;
  }
  case "status":
    await status();
    break;
  case "crank":
    console.log("crank:", await n.crank(c, user, position));
    break;
  case "redeem": {
    const r = await n.redeemAll(c, user, position);
    console.log(`redeem ${r.amount} Gemas:`, r.sig);
    break;
  }
  case "unlock":
    console.log("unlock:", await n.unlock(c, user, position));
    break;
  case "sweep":
    console.log("sweep:", await n.sweep(c, user, position));
    break;
  default:
    console.error("usage: cli.ts faucet | account | price <usd> | open <simSOL> <months> | status | crank | redeem | unlock | sweep");
    process.exit(1);
}
