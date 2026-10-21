/** Test helpers: real Tesoro Core instructions built from the IDL with the program's own PDA resolution. */
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { CORE_ID, type Ix } from "./rules";

const provider = new AnchorProvider(
  new Connection("http://127.0.0.1:9", "confirmed"),
  { publicKey: Keypair.generate().publicKey, signTransaction: async (t: never) => t, signAllTransactions: async (t: never) => t },
  {},
);
const program = new Program(coreIdl as Idl, provider);

export const key = () => Keypair.generate().publicKey;
export const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, CORE_ID)[0];
const s = (v: string) => Buffer.from(v);
export const accountOf = (authority: PublicKey) => pda([s("account"), authority.toBuffer()]);
export const u64 = (n: number | bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/** An instruction of Tesoro Core: `accounts` fills what the IDL cannot derive (and any override). */
export async function coreIx(name: string, args: unknown[], accounts: Record<string, PublicKey | null>): Promise<Ix> {
  const ix = await (program.methods as any)[name.replace(/_(\w)/g, (_: string, c: string) => c.toUpperCase())](...args)
    .accountsPartial(accounts)
    .instruction();
  return { programId: ix.programId, keys: ix.keys, data: ix.data };
}

/** A complete, valid `open_match` for `authority` paid by `relayer`. */
export async function openMatchIx(relayer: PublicKey, authority: PublicKey, game: PublicKey, over: Record<string, PublicKey | null> = {}): Promise<Ix> {
  return coreIx("open_match", [game, new BN(500), new BN(1), new BN(7), false, 0, 4], {
    payer: relayer,
    playerAuthority: authority,
    gameProgram: game,
    programData: key(),
    pot: key(),
    offer: null,
    backerAccount: null,
    backerCounters: null,
    backerProtections: null,
    backerBasket: null,
    backerSpill: null,
    ...over,
  });
}

export const chunkIx = (relayer: PublicKey, matchState: PublicKey, extra = 0) =>
  coreIx("match_chunk", [12], { caller: relayer, matchState, potA: key(), potB: key() }).then((ix) => {
    for (let i = 0; i < extra; i++) ix.keys.push({ pubkey: key(), isSigner: false, isWritable: i % 2 === 0 });
    return ix;
  });

const books = (authority: PublicKey) => {
  const ownerAccount = accountOf(authority);
  return { ownerAccount, basket: pda([s("basket"), ownerAccount.toBuffer()]), spill: pda([s("spill"), ownerAccount.toBuffer()]) };
};
export const sponsorPda = pda([s("sponsor")]);
const line = { side: 0, dueAt: new BN(0), class: 0, tranche: 0 };

/**
 * The Player's own exits and orders, each a complete, valid instruction for `authority`. The relayer holds no slot in
 * any of them: it only pays the fee, the Player signs as the authority.
 */
export const playerIx = {
  redeem: (a: PublicKey) => coreIx("redeem", [line, new BN(5)], { holderAuthority: a, position: key(), source: key() }),
  redeemPrize: (a: PublicKey) => coreIx("redeem_prize", [new BN(5)], { holderAuthority: a, prizeSource: key() }),
  unlock: (a: PublicKey) => coreIx("unlock", [], { ownerAuthority: a, position: key() }),
  /** `payer` pays the order's rent: the holder, or the relayer with `sponsored` (the sponsor account repays it). */
  requestInstantRedeem: (a: PublicKey, payer = a, sponsored = false) =>
    coreIx("request_instant_redeem", [line, new BN(5), new BN(3600), new BN(1)], { payer, holderAuthority: a, position: key(), source: key(), sponsor: sponsored ? sponsorPda : null }),
  cancelInstantRedeem: (a: PublicKey, order = key(), payer = a, sponsored = false) =>
    coreIx("cancel_instant_redeem", [], { signer: a, ...books(a), order, ownerWallet: payer, sponsor: sponsored ? sponsorPda : null }),
  expireInstantRedeem: (a: PublicKey, order = key(), payer = a, sponsored = false) =>
    coreIx("expire_instant_redeem", [], { signer: a, ...books(a), order, ownerWallet: payer, sponsor: sponsored ? sponsorPda : null }),
  returnOwn: (a: PublicKey) => coreIx("return_own", [line, new BN(5)], { ownerAuthority: a, position: key(), source: key() }),
  openNativePosition: (a: PublicKey) => coreIx("open_native_position", [new BN(1), new BN(5)], { ownerAuthority: a, mint: key(), ownerToken: key(), position: key(), vault: key() }),
  takeNativeAdvance: (a: PublicKey, position = key()) => coreIx("take_native_advance", [3], { ownerAuthority: a, position, source: key() }),
  openStakePosition: (a: PublicKey) => coreIx("open_stake_position", [new BN(1), new BN(5)], { ownerAuthority: a, mint: key(), vault: key(), ownerToken: key(), stakePool: key(), position: key() }),
  takeStakeAdvance: (a: PublicKey, position = key()) => coreIx("take_stake_advance", [3], { ownerAuthority: a, position, onchainPrice: key(), priceFeed: key(), custody: key(), stakePool: key(), source: key() }),
  cancelOffer: (a: PublicKey, offer = key()) => coreIx("cancel_offer", [], { backerAuthority: a, offer, request: null }),
  cancelRequest: (a: PublicKey, request = key()) => coreIx("cancel_request", [], { playerAuthority: a, request }),
  claimFreeYield: (a: PublicKey) => coreIx("claim_free_yield", [new BN(5)], { ownerAuthority: a, position: key() }),
};

/**
 * open_ticket (Backing) + stage_entry as one transaction, relayer paying, signed by the Requester alone: the accepted Offer
 * is the Backer's consent (the program never asks a Backer to sign a Backing Ticket's staging).
 */
export async function backingPairIx(relayer: PublicKey, parties: { requester?: PublicKey; backer?: PublicKey } = {}) {
  const requester = parties.requester ?? key();
  const backer = parties.backer ?? key();
  const backerAccount = accountOf(backer);
  const ticket = pda([s("ticket"), backerAccount.toBuffer(), u64(1)]);
  const open = await coreIx("open_ticket", [new BN(1), { backing: {} }, key(), new BN(500), 4], {
    payer: relayer,
    authority: requester,
    owner: backerAccount,
    ticket,
    offer: key(),
    sponsor: null,
  });
  const stage = await coreIx("stage_entry", [8], { signer: requester, owner: backerAccount, ticket });
  return { ixs: [open, stage], requester, backer, backerAccount, ticket };
}
