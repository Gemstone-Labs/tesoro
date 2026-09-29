import "./polyfill";
import { Connection } from "@solana/web3.js";
import type { Idl } from "@coral-xyz/anchor";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import { HoldemChain } from "@/games/holdem/chain";
import blockPuzzleIdl from "./idl/block_puzzle.json";
import holdemIdl from "./idl/holdem.json";
import coreIdl from "./idl/tesoro_core.json";
import { BASE_RPC_URL } from "./config";

let chain: BlockPuzzleChain | null = null;
let holdem: HoldemChain | null = null;

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

/** The Hold'em client (table on the private rollup), sharing the base-layer connection. */
export function getHoldem(): HoldemChain {
  if (!holdem) holdem = new HoldemChain(holdemIdl, coreIdl, { base: getChain().base });
  return holdem;
}
