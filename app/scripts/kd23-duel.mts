/**
 * Devnet: the Trading Duel table that is Over on base, who its Match is, and (with `finalize`) settle it with a QA dev key (permissionless;
 * the caller pays the receipt rent). cd app && ../keeper/node_modules/.bin/tsx scripts/kd23-duel.mts [finalize]
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
const { getTradingDuel } = await import("@/lib/chain/client");
const { keypairSigner, tablePda } = await import("@/games/trading-duel/chain");
const duel = getTradingDuel();
const t = await duel.readTableOnBase({ generation: Number(process.env.GEN ?? 0), index: Number(process.env.IDX ?? 0) } as never).catch(() => null);
console.log("table", t && { match: t.tesoroMatch.toBase58(), epoch: t.epoch, phase: t.phase, startsAt: t.startsAt, ring: t.ring.map((s) => s.state).join("") });
if (t && process.argv[2] === "finalize") {
  const a = await duel.readAssignment(t.tesoroMatch);
  console.log("assignment", a && { epoch: a.epoch });
  const keys = JSON.parse(readFileSync(process.env.DEVKEYS ?? `${homedir()}/.cache/tesoro-tmp/qa/devkeys.json`, "utf8"));
  const kp = Keypair.fromSecretKey(bs58.decode(keys.qsA.sol));
  if (a) console.log("finalize", await duel.finalize(keypairSigner(kp), a));
}
void tablePda;
process.exit(0);
