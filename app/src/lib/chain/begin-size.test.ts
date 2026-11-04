import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import coreIdl from "./idl/tesoro_core.json";
import holdemIdl from "./idl/holdem.json";
import duelIdl from "./idl/trading_duel.json";
import vanguardIdl from "./idl/vanguard.json";
import burstIdl from "./idl/block_puzzle.json";
import { HoldemChain, keypairSigner as holdemSigner } from "../../games/holdem/chain";
import { TradingDuelChain } from "../../games/trading-duel/chain";
import { VanguardChain } from "../../games/vanguard/chain";
import { BlockBurstChain } from "../../games/block-puzzle/live-chain";
import { MAX_BEGIN_RECEIPTS, beginSettled } from "./table-clean";

/** The largest transaction the network accepts. */
const PACKET = 1232;
/** One more receipt is one more account key (32 bytes) and one more index in the instruction (1 byte). */
const PER_RECEIPT = 33;

const key = () => Keypair.generate().publicKey;
const SLOT_DONE = 2;
/** The worst table `begin_match` can be asked about: its own Match and a full ring of eight other Matches. */
const worstTable = () => ({ tesoroMatch: key(), ring: Array.from({ length: 8 }, () => ({ state: SLOT_DONE, tesoroMatch: key() })) });
const assignment = () => ({ address: key(), tesoroMatch: key(), generation: 0, index: 2, epoch: 4, startDeadline: 1300, payer: key(), players: [key(), key()], speed: 0, asset: {} }) as never;

type Begin = (chain: never, payer: never, a: never, table?: never) => Promise<unknown>;

/** Each Game's real chain client with its sender replaced by one that keeps the instructions the page would send. */
function games(): { name: string; make: () => { chain: unknown; sent: TransactionInstruction[][] } }[] {
  const stub = (chain: unknown) => {
    const sent: TransactionInstruction[][] = [];
    const grab = async (_step: string, ixs: TransactionInstruction[]) => (sent.push(ixs), "sig");
    Object.assign(chain as Record<string, unknown>, {
      sendTee: grab,
      sendBase: grab,
      readConfig: async () => ({ teeValidator: key(), oracleQueue: key() }),
    });
    return { chain, sent };
  };
  return [
    { name: "Hold'em", make: () => stub(new HoldemChain(holdemIdl as never, coreIdl)) },
    { name: "Trading Duel", make: () => stub(new TradingDuelChain(duelIdl as never, coreIdl)) },
    { name: "Vanguard", make: () => stub(new VanguardChain(vanguardIdl as never, coreIdl)) },
    { name: "Block Burst", make: () => stub(new BlockBurstChain(burstIdl as never, coreIdl)) },
  ];
}

/**
 * The bytes of the transaction a page sends: legacy format (the page sends to the rollup with no lookup table), the Player
 * as fee payer and only signer, serialized with its one signature slot.
 */
function sizeOf(ixs: TransactionInstruction[], payer: PublicKey): number {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer;
  tx.recentBlockhash = key().toBase58();
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
}

describe("begin_match fits one transaction", () => {
  for (const g of games()) {
    it(`${g.name}: the worst case (every receipt, the ending group) is under ${PACKET} bytes, and the cap is what fits`, async () => {
      const { chain, sent } = g.make();
      const player = holdemSigner(Keypair.generate());
      const begin = (chain as { beginMatch: Begin }).beginMatch.bind(chain) as unknown as (p: unknown, a: unknown, t?: unknown) => Promise<unknown>;

      await begin(player, assignment());
      const bare = sizeOf(sent[0], player.publicKey);

      const table = worstTable();
      expect(beginSettled(table)).toHaveLength(MAX_BEGIN_RECEIPTS);
      await begin(player, assignment(), table);
      const worst = sizeOf(sent[1], player.publicKey);

      expect(worst).toBe(bare + PER_RECEIPT * MAX_BEGIN_RECEIPTS);
      expect(worst).toBeLessThanOrEqual(PACKET);
      // How many receipts would fit, derived from this Game's own transaction: the cap must not exceed it.
      const fits = Math.floor((PACKET - bare) / PER_RECEIPT);
      expect(MAX_BEGIN_RECEIPTS).toBeLessThanOrEqual(fits);
      console.log(`${g.name}: begin ${bare} B bare, ${worst} B with ${MAX_BEGIN_RECEIPTS} receipts, room for ${fits} receipts`);
    });
  }

  it("the cap is a table's own Match plus one per ring slot", () => {
    expect(MAX_BEGIN_RECEIPTS).toBe(1 + worstTable().ring.length);
  });
});
