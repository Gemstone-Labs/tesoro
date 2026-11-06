import { PublicKey } from "@solana/web3.js";
import { gameOfProgram } from "../../lib/chain/games";
import coreIdl from "../../lib/chain/idl/tesoro_core.json";
import { recordsOfRawTx, type RawTx } from "../history/webhook";
import { matchKeyOf } from "../history/match-key";
import { CORE_WINDOW_SECS } from "../../lib/chain/match-status";
import { coreInstructionsOf, type CoreInstruction } from "./core-ix";
import type { MatchPlayer, OpenMatchStore } from "./store";

const CORE = new PublicKey((coreIdl as { address: string }).address);

/** tesoro_core's `["match", opener Account, counter as u64 LE]`. */
export function matchStateOf(opener: string, n: bigint): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64LE(n);
  return PublicKey.findProgramAddressSync([Buffer.from("match"), new PublicKey(opener).toBuffer(), counter], CORE)[0].toBase58();
}

/** Keeps the open-Match table in step with the Match instructions of a transaction. */
async function trackMatch(ix: CoreInstruction, tx: RawTx, matches: OpenMatchStore): Promise<void> {
  const player = (): MatchPlayer | null => {
    const account = ix.account("player_account");
    const authority = ix.account("player_authority");
    return account && authority ? { account, authority } : null;
  };
  const matchState = ix.account("match_state");
  if (!matchState) return;
  if (ix.name === "open_match") {
    const opener = player();
    const game = gameOfProgram(new PublicKey(ix.data.subarray(0, 32)));
    if (!opener || !game) return;
    const entry = Number(ix.data.readBigUInt64LE(32));
    const n = ix.data.readBigUInt64LE(40);
    await matches.open({ matchState, matchKey: matchKeyOf({ opener: opener.account, n }), game, entry, opener });
  } else if (ix.name === "join_match") {
    const joiner = player();
    if (joiner && tx.blockTime) await matches.join(matchState, joiner, tx.blockTime + CORE_WINDOW_SECS);
  } else if (ix.name === "extend_match_deadline") {
    await matches.extend(matchState, Number(ix.data.readBigInt64LE(0)));
  }
}

/** Keeps the open-Match table in step with the Match instructions of one stored transaction. Safe to run twice on the same transaction. */
export async function trackTx(tx: RawTx, matches: OpenMatchStore): Promise<void> {
  for (const ix of coreInstructionsOf(tx)) await trackMatch(ix, tx, matches);
  for (const record of recordsOfRawTx(tx)) {
    if (record.type === "start") await matches.close(matchStateOf(record.opener, record.n));
  }
}
