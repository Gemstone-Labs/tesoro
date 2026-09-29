import "./polyfill";
import { Connection } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import blockPuzzleIdl from "./idl/block_puzzle.json";
import coreIdl from "./idl/tesoro_core.json";
import { BASE_RPC_URL } from "./config";

let chain: BlockPuzzleChain | null = null;

/** One client per tab: base-layer connection plus the two IDL programs. */
export function getChain(): BlockPuzzleChain {
  if (!chain) {
    chain = new BlockPuzzleChain({
      base: new Connection(BASE_RPC_URL, "confirmed"),
      blockPuzzleIdl: blockPuzzleIdl as Idl,
      coreIdl: coreIdl as Idl,
    });
  }
  return chain;
}
