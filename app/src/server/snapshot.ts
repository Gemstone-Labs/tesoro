import { Program, utils, type Idl, type Provider } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { OVERFLOW_DISC, OVERFLOW_OWNER_AT, decodeOverflowRecord } from "@/lib/chain/overflow";
import { isCurrentPosition, positionBytes } from "@/lib/chain/position-size";
import { readAccountState, type StateSource } from "@/lib/chain/account-state";
import { baseRpc } from "@/lib/chain/rpc-config";
import { encodeState } from "@/lib/chain/snapshot-wire";
import { getAccounts, getOwnedFresh, parseQuery, type GpaQuery } from "./gpa";

const CORE = coreIdl.address;
/** Decodes like the browser's `chain.core`: Anchor's Program turns the IDL into camelCase fields and account names. */
const coder = new Program(coreIdl as Idl, {} as Provider).coder.accounts;
const discOf = (name: string) => {
  const a = coreIdl.accounts.find((x) => x.name === name);
  if (!a) throw new Error(`tesoro_core has no account ${name}`);
  return Buffer.from(a.discriminator);
};

/** The base58 discriminator, the form `parseQuery` takes. */
const encodeDisc = (name: string) => utils.bytes.bs58.encode(discOf(name));

const query = (name: "PositionState", offset: number, accountKey: PublicKey): GpaQuery =>
  parseQuery(new URLSearchParams([["program", CORE], ["filter", `m:0:${encodeDisc(name)}`], ["filter", `m:${offset}:${accountKey.toBase58()}`]]));

/** The Account's overflow records: the owner Account's key sits in the store header of each record. */
const overflowQuery = (accountKey: PublicKey): GpaQuery =>
  parseQuery(new URLSearchParams([["program", CORE], ["filter", `m:0:${utils.bytes.bs58.encode(OVERFLOW_DISC)}`], ["filter", `m:${OVERFLOW_OWNER_AT}:${accountKey.toBase58()}`]]));

type GpaRow = { pubkey: string; account: { data: [string, string] } };

export interface SnapshotDeps {
  lists: (q: GpaQuery) => Promise<GpaRow[]>;
  /** One owner's rows straight from upstream (a filtered `getProgramAccounts`). */
  owned: (q: GpaQuery) => Promise<GpaRow[]>;
  connection: Pick<Connection, "getMultipleAccountsInfo" | "getBalance">;
}

/** The cached rows with this owner's rows from the filtered read laid over them (same key: the newer row wins). */
function mergeOwned(cached: GpaRow[], owned: GpaRow[]): GpaRow[] {
  const byKey = new Map(cached.map((r) => [r.pubkey, r]));
  for (const r of owned) byKey.set(r.pubkey, r);
  return [...byKey.values()];
}

/** The Account's state for the app: the same read the browser makes, with the lists from the server cache and the rest on the server's RPC. */
export function serverStateSource(deps: SnapshotDeps, opts: { fresh?: boolean } = {}): StateSource {
  const decodeRows = (rows: GpaRow[]) =>
    rows
      .map((r) => ({ key: r.pubkey, data: Buffer.from(r.account.data[0], "base64") }))
      .filter((r) => isCurrentPosition(r.data))
      .map((r) => ({ publicKey: new PublicKey(r.key), account: coder.decode("positionState", positionBytes(r.data)) }));
  return {
    lists: async (key) => {
      const q = query("PositionState", 41, key);
      const cached = await deps.lists(q);
      if (!opts.fresh) return decodeRows(cached);
      // The global list stays as cached; this Account's own rows are read directly and win. If that read fails, the cached rows answer.
      const owned = await deps.owned(q).catch(() => []);
      return decodeRows(mergeOwned(cached, owned));
    },
    overflow: async (key) => {
      const q = overflowQuery(key);
      const cached = await deps.lists(q);
      // After this tab's own transaction, records the cache still shows are read upstream (a Claim just emptied them); an
      // Account with none costs no extra query, and a record made since the cache was filled shows within its 2 minutes.
      const owned = opts.fresh && cached.length > 0 ? await deps.owned(q).catch(() => null) : null;
      const rows = owned ?? cached;
      return rows.flatMap((r) => decodeOverflowRecord(new PublicKey(r.pubkey), Buffer.from(r.account.data[0], "base64")) ?? []);
    },
    infos: async (keys) => (await deps.connection.getMultipleAccountsInfo(keys, "confirmed")) as never,
    balance: (authority) => deps.connection.getBalance(authority, "confirmed"),
    decode: (name, data) => coder.decode(name, data),
  };
}

let conn: Connection | null = null;
const connection = () => (conn ??= new Connection(baseRpc(process.env.TESORO_BASE_RPC), { commitment: "confirmed" }));

/** JSON for `/api/account/<authority>`. `fresh`: the Account just sent a transaction, so its own Positions are read upstream and merged over the cached lists. */
export async function getAccountState(authority: PublicKey, opts: { fresh?: boolean } = {}, deps: SnapshotDeps = { lists: getAccounts, owned: getOwnedFresh, connection: connection() }): Promise<unknown> {
  const state = await readAccountState(serverStateSource(deps, opts), authority, BlockPuzzleChain.coreAccount(authority));
  return encodeState(state);
}
