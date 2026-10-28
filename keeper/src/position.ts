// A tesoro_core Position of either layout: 235 bytes until `migrate_position` rewrites it (ticket 55), 243 after.
import type { Connection, PublicKey } from "@solana/web3.js";
import { LEGACY_POSITION_SPACE, POSITION_SPACE, positionBytes } from "../../app/src/lib/chain/position-size.ts";

/** What these helpers need of the core program (an anchor `Program`, or the keeper's looser `Core` / `AnyProgram`). */
type CoreCoder = { coder: { accounts: { decode(name: string, data: Buffer): any; memcmp(name: string): any } } };
type CoreReader = CoreCoder & { programId: PublicKey; provider: { connection: Connection } };

/** Decodes a Position account's data with the core coder (camelCase fields), whichever layout it has. */
export const decodeCorePosition = (core: CoreCoder, data: Uint8Array): any => core.coder.accounts.decode("positionState", positionBytes(data));

/** Reads one Position (null when the account does not exist). */
export async function fetchCorePosition(core: CoreReader, key: PublicKey): Promise<any | null> {
  const info = await core.provider.connection.getAccountInfo(key);
  return info ? decodeCorePosition(core, info.data) : null;
}

/** The size filters that list every Position the program can read. */
export const positionQueries = () => [{ dataSize: POSITION_SPACE }, { dataSize: LEGACY_POSITION_SPACE }];

/** Every Position, as `program.account.positionState.all()` would return them, of both layouts. */
export async function allCorePositions(core: CoreReader): Promise<{ publicKey: PublicKey; account: any }[]> {
  const disc = core.coder.accounts.memcmp("positionState");
  const lists = await Promise.all(
    positionQueries().map((size) => core.provider.connection.getProgramAccounts(core.programId, { filters: [size, { memcmp: disc }] })),
  );
  return lists.flat().map((r) => ({ publicKey: r.pubkey, account: decodeCorePosition(core, r.account.data) }));
}
