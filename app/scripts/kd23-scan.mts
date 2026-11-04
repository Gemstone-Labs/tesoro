/**
 * Devnet scan for the final-board capture (keeper-diet ticket 23): which tables on base hold a finished Match that has a finalize
 * transaction, and does the capture keep its board? Read-only on devnet; the history is an in-process Postgres (nothing written to Supabase).
 *   cd app && ../keeper/node_modules/.bin/tsx scripts/kd23-scan.mts [rpcUrl]
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import * as h from "../src/games/holdem/chain";
import * as d from "../src/games/trading-duel/chain";
import * as b from "../src/games/block-puzzle/live-chain";
import * as v from "../src/games/vanguard/chain";
import holdemIdl from "../src/lib/chain/idl/holdem.json";
import duelIdl from "../src/lib/chain/idl/trading_duel.json";
import burstIdl from "../src/lib/chain/idl/block_puzzle.json";
import vanguardIdl from "../src/lib/chain/idl/vanguard.json";
import { captureEndStates, connectionBaseReader } from "../src/server/history/end-capture";
import { endStateOf } from "../src/server/history/end-state";
import { testDb } from "../src/server/history/test-db";
import { jsonRpcCoreChain, slim } from "../src/server/history/webhook";

const url = process.argv[2] ?? "https://rpc.magicblock.app/devnet";
const c = new Connection(url, "confirmed");
const chain = jsonRpcCoreChain(url, "11111111111111111111111111111111");
const GAMES = [
  { name: "holdem", pda: h.tablePda, idl: holdemIdl, over: (t: any) => t.phase === 3 },
  { name: "trading-duel", pda: d.tablePda, idl: duelIdl, over: (t: any) => t.phase === 3 },
  { name: "block-puzzle", pda: b.tablePda, idl: burstIdl, over: (t: any) => t.phase === 4 },
  { name: "vanguard", pda: v.tablePda, idl: vanguardIdl, over: (t: any) => t.phase === 3 },
] as const;
const { rpc } = await testDb();
for (const g of GAMES.filter((x) => !process.env.ONLY || x.name === process.env.ONLY)) {
  const coder = new Program(g.idl as never, { connection: c } as never).coder.accounts;
  const addrs: PublicKey[] = [];
  for (let gen = 0; gen < 3; gen++) for (let i = 0; i < 60; i++) addrs.push(g.pda(gen, i));
  const found: { address: PublicKey; match: PublicKey; epoch: number }[] = [];
  for (let k = 0; k < addrs.length; k += 100) {
    const infos = await c.getMultipleAccountsInfo(addrs.slice(k, k + 100));
    infos.forEach((info, j) => {
      if (!info || info.data.length < 100) return;
      const t: any = coder.decode("table", Buffer.from(info.data));
      if (g.over(t) && !t.tesoroMatch.equals(PublicKey.default)) found.push({ address: addrs[k + j], match: t.tesoroMatch, epoch: t.epoch.toNumber() });
    });
  }
  console.log(g.name, "tables over on base:", found.length);
  for (const f of found) {
    const sigs: Awaited<ReturnType<typeof c.getSignaturesForAddress>> = [];
    for (let page = 0; page < Number(process.env.PAGES ?? 1); page++) {
      const part = await c.getSignaturesForAddress(f.address, { limit: Number(process.env.LIMIT ?? 40), before: sigs.at(-1)?.signature });
      sigs.push(...part);
      if (part.length < Number(process.env.LIMIT ?? 40)) break;
    }
    let done = false;
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await chain.transaction(s.signature).catch(() => null);
      if (!tx) continue;
      const out = await captureEndStates({ rpc, base: connectionBaseReader(c) }, { signature: s.signature, slot: tx.slot, blockTime: tx.blockTime ?? null, body: slim(tx) });
      if (out.some((o) => o.match === f.match.toBase58())) {
        console.log(" ", f.address.toBase58().slice(0, 6), f.match.toBase58().slice(0, 6), JSON.stringify(out));
        const stored = await endStateOf(rpc, f.match.toBase58());
        if (stored) console.log("    stored", JSON.stringify(stored).slice(0, 220));
        done = true;
        break;
      }
    }
    if (!done) console.log(" ", f.address.toBase58().slice(0, 6), f.match.toBase58().slice(0, 6), "no finalize found in last 40 signatures");
  }
}
process.exit(0);
