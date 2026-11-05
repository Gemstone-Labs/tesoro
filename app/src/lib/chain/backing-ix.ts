import "./polyfill";
import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import { basketPda, countersPda, spillPda } from "./basket";
import { coreIx, CORE_PROGRAM_ID } from "./core-ix";
import { gameRecordPda } from "./game-record";
import { u64 } from "./native";

/**
 * The Backing instructions a Player and a Backer sign (tesoro_core `instructions/backing.rs`), built from the IDL with no
 * network: a Request for a Game and entry, an Offer on it, the Player accepting it. backing.ts sends them; the LiteSVM
 * tests run them as the app builds them.
 */

const key = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, CORE_PROGRAM_ID)[0];
const accountOf = (authority: PublicKey) => key([Buffer.from("account"), authority.toBuffer()]);
const protectionsOf = (account: PublicKey) => key([Buffer.from("protections"), account.toBuffer()]);

export const requestPda = (player: PublicKey, nonce: bigint) => key([Buffer.from("request"), player.toBuffer(), u64(nonce)]);
export const offerPda = (backer: PublicKey, nonce: bigint) => key([Buffer.from("offer"), backer.toBuffer(), u64(nonce)]);

/** A fresh nonce for a Request or an Offer: the clock in ms with three random digits. */
export const backingNonce = (): bigint => BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

/** `create_request`: the Player (wallet `player`) asks to be backed for `game` (its program) at `entry`. */
export function createRequestIx(a: { player: PublicKey; game: PublicKey; entry: bigint; nonce: bigint }): { ix: TransactionInstruction; address: PublicKey } {
  const account = accountOf(a.player);
  const address = requestPda(account, a.nonce);
  const ix = coreIx(
    "create_request",
    {
      player_authority: a.player,
      config: key([Buffer.from("config")]),
      game_record: gameRecordPda(a.game),
      player_account: account,
      protections: protectionsOf(account),
      request: address,
      system_program: SystemProgram.programId,
    },
    { nonce: a.nonce, game: a.game, entry: a.entry },
  );
  return { ix, address };
}

/** `create_offer`: the Backer (wallet `backer`) answers a Request, reserving its entry; the Player keeps `shareBps` of the winnings. */
export function createOfferIx(a: { backer: PublicKey; request: PublicKey; game: PublicKey; shareBps: number; nonce: bigint }): { ix: TransactionInstruction; address: PublicKey } {
  const account = accountOf(a.backer);
  const address = offerPda(account, a.nonce);
  const ix = coreIx(
    "create_offer",
    {
      backer_authority: a.backer,
      config: key([Buffer.from("config")]),
      request: a.request,
      game_record: gameRecordPda(a.game),
      backer_account: account,
      protections: protectionsOf(account),
      basket: basketPda(account),
      spill: spillPda(account),
      counters: countersPda(account),
      offer: address,
      system_program: SystemProgram.programId,
    },
    { nonce: a.nonce, player_share_bps: a.shareBps },
  );
  return { ix, address };
}

/** `accept_offer`: the Player takes an Offer made on their Request. */
export function acceptOfferIx(a: { player: PublicKey; request: PublicKey; offer: PublicKey }): TransactionInstruction {
  const account = accountOf(a.player);
  return coreIx("accept_offer", { player_authority: a.player, player_account: account, protections: protectionsOf(account), request: a.request, offer: a.offer });
}
