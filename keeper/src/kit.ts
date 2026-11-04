import { PublicKey } from "@solana/web3.js";
import { loadIdl } from "./runtime.ts";

export const CORE_ID = new PublicKey(loadIdl("tesoro_core").address);

const le = (n: bigint | number, bytes: number) => {
  const b = Buffer.alloc(bytes);
  if (bytes === 8) b.writeBigUInt64LE(BigInt(n));
  else b.writeUInt32LE(Number(n));
  return b;
};
export const u64le = (n: bigint | number) => le(n, 8);
export const u32le = (n: bigint | number) => le(n, 4);

export const pda = (...seeds: (string | Uint8Array)[]): PublicKey =>
  PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s)),
    CORE_ID,
  )[0];

export const keyOf = (bytes: ArrayLike<number> | PublicKey): PublicKey => (bytes instanceof PublicKey ? bytes : new PublicKey(Uint8Array.from(bytes)));

/** A Match is named by its opener's Account and the opener's counter value. */
export interface MatchRef {
  opener: PublicKey;
  n: bigint;
}

export const matchRefOf = (id: { opener: ArrayLike<number> | PublicKey; n: { toString(): string } }): MatchRef => ({ opener: keyOf(id.opener), n: BigInt(id.n.toString()) });

export const matchLabel = (m: MatchRef) => `${m.opener.toBase58().slice(0, 4)}…-${m.n}`;

export const matchAddress = (m: MatchRef) => pda("match", m.opener.toBuffer(), u64le(m.n));
export const receiptAddress = (match: PublicKey) => pda("settled", match.toBuffer());
export const basketOf = (account: PublicKey) => pda("basket", account.toBuffer());
export const spillOf = (account: PublicKey) => pda("spill", account.toBuffer());
export const countersOf = (account: PublicKey) => pda("counters", account.toBuffer());
export const bookOf = (source: PublicKey) => pda("book", source.toBuffer());
export const ckptOf = (source: PublicKey, cls: number, page: number) => pda("ckpt", source.toBuffer(), Buffer.from([cls]), u32le(page));
export const eventAuthority = pda("__event_authority");
export const configAddress = pda("config");
export const economyAddress = pda("economy");
export const sponsorAddress = pda("sponsor");
export const gameRecordOf = (program: PublicKey) => pda("game", program.toBuffer());
export const seasonAddress = (n: number) => pda("season", u32le(n));
export const reservationsAddress = pda("pool_reservations");
export const prizeSourceOf = (custody: PublicKey, season: number) => pda("prize", custody.toBuffer(), u32le(season));
export const orderAddress = (account: PublicKey, nonce: bigint) => pda("instant", account.toBuffer(), u64le(nonce));
/** What an overflow record was made for (storage.rs `OVERFLOW_*`). */
export const OVERFLOW_MATCH = 0;
export const OVERFLOW_SEASON = 1;
export const OVERFLOW_ROUTE = 2;
/** The 40-byte id of the record a Match makes for an Account: the opener's Account then the counter. */
export const matchOverflowId = (m: MatchRef): Buffer => Buffer.concat([m.opener.toBuffer(), u64le(m.n)]);
/** The id of a Season prize step's record: the Season number, the rank and the line, then zeros. */
export const seasonOverflowId = (season: number, rank: number, line: number): Buffer => {
  const id = Buffer.alloc(40);
  id.writeUInt32LE(season, 0);
  id[4] = rank;
  id[5] = line;
  return id;
};
/** The id of a Pool route record: the Season number then the route's custody, then zeros (`route_overflow_id`). */
export const routeOverflowId = (season: number, custody: PublicKey): Buffer => {
  const id = Buffer.alloc(40);
  id.writeUInt32LE(season, 0);
  custody.toBuffer().copy(id, 4);
  return id;
};
/** `["overflow", owner, kind, id[..32], id[32..]]`: a seed is at most 32 bytes. */
export const overflowAddress = (owner: PublicKey, kind: number, id: Uint8Array) => pda("overflow", owner.toBuffer(), Buffer.from([kind]), id.subarray(0, 32), id.subarray(32));
export const pairAddress = (opener: PublicKey, joiner: PublicKey) => pda("pair2", opener.toBuffer(), joiner.toBuffer());

export const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
/** The ProgramData account of an upgradeable program. */
export const programDataOf = (program: PublicKey) => PublicKey.findProgramAddressSync([program.toBuffer()], BPF_LOADER_UPGRADEABLE)[0];

// Line stores (baskets, spills, Tickets, Pots) are decoded in the app, so the page and the keeper read them the same way.
export * from "../../app/src/lib/chain/pot-store.ts";
