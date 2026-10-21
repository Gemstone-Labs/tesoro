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
