// QA helper: a tesoro_core Match's status, its Hold'em table (if any) and the latest signatures on the Match (read-only).
//   tsx scripts/qa-match-state.ts <match id>
import { Keypair } from "@solana/web3.js";
import { BlockPuzzleChain } from "../../app/src/games/block-puzzle/chain.ts";
import { settings } from "../src/env.ts";
import { buildRuntime, newConnection } from "../src/runtime.ts";

const id = BigInt(process.argv[2]);
const s = settings([]);
const conn = newConnection(s.rpc, s.gpaRpc);
const rt = buildRuntime(s, conn, Keypair.generate());
const match = BlockPuzzleChain.addresses(id).match;
const m: any = await rt.core.account.matchState.fetch(match);
console.log("match", match.toBase58(), "status", Object.keys(m.inner.status)[0]);
const t = await rt.holdem.readTableOnBase(id).catch(() => null);
if (t) console.log("holdem table status", t.status, "finalized", t.finalized, "start_deadline", new Date(t.startDeadline * 1000).toISOString());
for (const x of await conn.getSignaturesForAddress(match, { limit: 10 })) {
  console.log(new Date((x.blockTime ?? 0) * 1000).toISOString(), x.err ? `ERR ${JSON.stringify(x.err)}` : "ok", x.signature);
}
process.exit(0);
