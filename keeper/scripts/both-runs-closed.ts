/**
 * Devnet fixture for the keeper: plays a Block Puzzle Match up to "both runs closed" and stops, so the
 * keeper (not a Player client) does `seal` + `commit_boards` + `settle`.
 *
 *   pnpm --filter @tesoro/keeper exec tsx scripts/both-runs-closed.ts
 *
 * Uses the two test wallets in ~/.config/tesoro/block-puzzle-testers.json (staked by
 * programs/block_puzzle/scripts/devnet-match.ts), the deployer as fee payer, and only the app's chain client.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { BlockPuzzleChain, keypairSigner, type Move } from "../../app/src/games/block-puzzle/chain.ts";
import { apply, dims, fitsAt, handBase, newState, pieceAt, SIZE, HAND } from "../../app/src/games/block-puzzle/engine.ts";
import { buildRuntime, newConnection } from "../src/runtime.ts";
import { settings } from "../src/env.ts";

const kp = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
const testers = (JSON.parse(readFileSync(join(homedir(), ".config/tesoro/block-puzzle-testers.json"), "utf8")) as number[][]).map((k) => Keypair.fromSecretKey(Uint8Array.from(k)));
const deployer = kp(join(homedir(), ".config/solana/id.json"));
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

/** Own-sourced Holding of a tester staked by devnet-match.ts (position ids 11 and 12, source index 0). */
const holdingOf = (signer: ReturnType<typeof keypairSigner>, id: number) => {
  const position = PublicKey.findProgramAddressSync([Buffer.from("position"), Buffer.from([0]), Buffer.from(Array(32).fill(id))], rt.core.programId)[0];
  const source = PublicKey.findProgramAddressSync([Buffer.from("source"), position.toBuffer(), Buffer.alloc(4)], rt.core.programId)[0];
  return BlockPuzzleChain.holding(BlockPuzzleChain.coreAccount(signer.publicKey), source);
};

const id = BigInt(Date.now());
console.log("match id", id.toString(), "match", BlockPuzzleChain.addresses(id).match.toBase58());
console.log("open", await chain.openMatch(S0, id, 1000, [holdingOf(S0, 11)]));
await chain.delegateOpener(D, id);
await chain.initVaultPermission(S0, id);
await chain.initPermission(S0, id, 0);
await chain.requestSeed(S0, id);
for (let i = 0; i < 40 && !(await chain.seedReady(S0, id)); i++) await sleep(1500);
const { seed } = await chain.beginRun(S0, id, 0);
await chain.play(S0, id, 0, greedy(seed, 20));
await chain.finish(S0, id, 0);
console.log("opener finished; joining");
console.log("join", await chain.joinMatch(S1, id, [holdingOf(S1, 12)]));
await chain.delegateJoiner(D, id);
await chain.initPermission(S1, id, 1);
await chain.beginRun(S1, id, 1);
await chain.play(S1, id, 1, greedy(seed, 8));
await chain.finish(S1, id, 1);
console.log("both runs closed, nothing sealed. Now run the keeper:", id.toString());
