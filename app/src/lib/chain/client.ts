import "./polyfill";
import type { Idl } from "@coral-xyz/anchor";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import { HoldemChain } from "@/games/holdem/chain";
import { TradingDuelChain } from "@/games/trading-duel/chain";
import { VanguardChain } from "@/games/vanguard/chain";
import blockPuzzleIdl from "./idl/block_puzzle.json";
import holdemIdl from "./idl/holdem.json";
import coreIdl from "./idl/tesoro_core.json";
import tradingDuelIdl from "./idl/trading_duel.json";
import vanguardIdl from "./idl/vanguard.json";
import { CLUSTER } from "@/lib/cluster-settings";
import { SOLANA_DEVNET_RPC } from "@/lib/solana-network";
import { BASE_RPC_URL } from "./config";
import { rpcFetch } from "./rpc-fetch";
import { SplitConnection, routeGpa } from "./split-connection";

/**
 * No RPC call waits forever (20 s), and a brief outage of the browser RPC is retried. In test mode the last
 * try goes to Solana's public devnet RPC, so one provider's 503 does not stop a Player. Mainnet has no fallback.
 */
const browserFetch = rpcFetch({ fallback: CLUSTER.id === "test" && BASE_RPC_URL !== SOLANA_DEVNET_RPC ? SOLANA_DEVNET_RPC : undefined });

let chain: BlockPuzzleChain | null = null;
let holdem: HoldemChain | null = null;
let tradingDuel: TradingDuelChain | null = null;
let vanguard: VanguardChain | null = null;

/** One client per tab: base-layer connection plus the two IDL programs. */
export function getChain(): BlockPuzzleChain {
  if (!chain) {
    chain = new BlockPuzzleChain({
      base: new SplitConnection(BASE_RPC_URL, routeGpa, { commitment: "confirmed", fetch: browserFetch }),
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

/** The Vanguard client (Battle and Armies on the private rollup), sharing the base-layer connection. */
export function getVanguard(): VanguardChain {
  if (!vanguard) vanguard = new VanguardChain(vanguardIdl, coreIdl, { base: getChain().base });
  return vanguard;
}
