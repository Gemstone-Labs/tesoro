import "./polyfill";
import type { Idl } from "@coral-xyz/anchor";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import { HoldemChain } from "@/games/holdem/chain";
import { TradingDuelChain } from "@/games/trading-duel/chain";
import blockPuzzleIdl from "./idl/block_puzzle.json";
import holdemIdl from "./idl/holdem.json";
import coreIdl from "./idl/tesoro_core.json";
import tradingDuelIdl from "./idl/trading_duel.json";
import { BASE_RPC_URL } from "./config";
import { SplitConnection, routeGpa } from "./split-connection";

let chain: BlockPuzzleChain | null = null;
let holdem: HoldemChain | null = null;
let tradingDuel: TradingDuelChain | null = null;

/** One client per tab: base-layer connection plus the two IDL programs. */
export function getChain(): BlockPuzzleChain {
  if (!chain) {
    chain = new BlockPuzzleChain({
      base: new SplitConnection(BASE_RPC_URL, routeGpa, "confirmed"),
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

/** The Trading Duel client (Duel and Books on the private rollup), sharing the base-layer connection. */
export function getTradingDuel(): TradingDuelChain {
  if (!tradingDuel) tradingDuel = new TradingDuelChain(tradingDuelIdl, coreIdl, { base: getChain().base });
  return tradingDuel;
}
