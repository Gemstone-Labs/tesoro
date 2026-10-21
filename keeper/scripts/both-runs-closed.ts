/**
 * Devnet fixture for the keeper: plays a Block Puzzle Match up to "both runs closed" and stops, so the
 * keeper (not a Player client) does `seal` + `commit_boards` + `settle`.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/both-runs-closed.ts
 *
 * Uses the two test wallets in ~/.config/tesoro/block-puzzle-testers.json (each holding 500 playable Gemas, see
 * programs/block_puzzle/scripts/devnet-match.ts), the deployer as fee payer, and only the app's chain client.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { keypairSigner, type Move } from "../../app/src/games/block-puzzle/chain.ts";
import { apply, dims, fitsAt, handBase, newState, pieceAt, SIZE, HAND } from "../../app/src/games/block-puzzle/engine.ts";
import { buildRuntime, newConnection } from "../src/runtime.ts";
import { settings } from "../src/env.ts";

const kp = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const testers = (JSON.parse(readFileSync(join(homedir(), ".config/tesoro/block-puzzle-testers.json"), "utf8")) as number[][]).map((k) => Keypair.fromSecretKey(Uint8Array.from(k)));
const deployer = kp(join(homedir(), ".config/solana/dev-2026-10.json"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function greedy(seed: bigint, n: number): Move[] {
  let st = newState(seed);
  const out: Move[] = [];
  while (out.length < n && !st.over) {
    const b = handBase(st);
    let played = false;
    for (let slot = 0; slot < HAND && !played; slot++) {
      if ((st.used >> slot) & 1) continue;
      const piece = pieceAt(seed, b + slot);
      const [w, h] = dims(piece);
      for (let y = 0; y <= SIZE - h && !played; y++)
        for (let x = 0; x <= SIZE - w && !played; x++)
          if (fitsAt(st, piece, x, y)) {
            out.push({ piece: b + slot, x, y });
            st = apply(st, { piece: b + slot, x, y }).state;
            played = true;
          }
    }
    if (!played) break;
  }
  return out;
}

const s = settings([]);
const conn = newConnection(s.rpc);
const rt = buildRuntime(s, conn, deployer);
const chain = rt.bp;
const [S0, S1, D] = [keypairSigner(testers[0]), keypairSigner(testers[1]), keypairSigner(deployer)];

const opened = await chain.openMatch(S0, 500);
const id = opened.match;
console.log("match", id.toBase58());
console.log("open", opened.sig);
await chain.delegateOpener(D, id);
await chain.initVaultPermission(S0, id);
await chain.initPermission(S0, id, 0);
await chain.requestSeed(S0, id);
for (let i = 0; i < 40 && !(await chain.seedReady(S0, id)); i++) await sleep(1500);
const { seed } = await chain.beginRun(S0, id, 0);
await chain.play(S0, id, 0, greedy(seed, 20));
await chain.finish(S0, id, 0);
console.log("opener finished; joining");
console.log("join", await chain.joinMatch(S1, id));
await chain.delegateJoiner(D, id);
await chain.initPermission(S1, id, 1);
await chain.beginRun(S1, id, 1);
await chain.play(S1, id, 1, greedy(seed, 8));
await chain.finish(S1, id, 1);
console.log("both runs closed, nothing sealed. Now run the keeper:", id.toBase58());
