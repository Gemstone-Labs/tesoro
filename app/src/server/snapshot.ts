import { Program, utils, type Idl, type Provider } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { BlockPuzzleChain } from "@/games/block-puzzle/chain";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { readAccountState, type StateSource } from "@/lib/chain/account-state";
import { DEFAULT_BASE_RPC } from "@/lib/chain/rpc-config";
import { encodeState } from "@/lib/chain/snapshot-wire";
import { getAccounts, invalidateAccountLists, parseQuery, type GpaQuery } from "./gpa";

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

const query = (name: "HoldingState" | "PositionState", offset: number, accountKey: PublicKey): GpaQuery =>
  parseQuery(new URLSearchParams([["program", CORE], ["filter", `m:0:${encodeDisc(name)}`], ["filter", `m:${offset}:${accountKey.toBase58()}`]]));

export interface SnapshotDeps {
  lists: (q: GpaQuery) => Promise<{ pubkey: string; account: { data: [string, string] } }[]>;
  connection: Pick<Connection, "getMultipleAccountsInfo" | "getBalance">;
  /** Marks the Holding and Position lists stale. */
  invalidate: () => void;
}

/** The Account's state for the app: the same read the browser makes, with the lists from the server cache and the rest on the server's RPC. */
export function serverStateSource(deps: SnapshotDeps): StateSource {
  const decodeRows = (name: "holdingState" | "positionState") => (rows: Awaited<ReturnType<SnapshotDeps["lists"]>>) =>
    rows.map((r) => ({ publicKey: new PublicKey(r.pubkey), account: coder.decode(name, Buffer.from(r.account.data[0], "base64")) }));
  return {
    lists: async (key) => {
      const [holdings, positions] = await Promise.all([deps.lists(query("HoldingState", 9, key)), deps.lists(query("PositionState", 41, key))]);
      return [decodeRows("holdingState")(holdings), decodeRows("positionState")(positions)];
    },
    infos: async (keys) => (await deps.connection.getMultipleAccountsInfo(keys, "confirmed")) as never,
    balance: (authority) => deps.connection.getBalance(authority, "confirmed"),
    decode: (name, data) => coder.decode(name, data),
  };
}

let conn: Connection | null = null;
const connection = () => (conn ??= new Connection(process.env.TESORO_BASE_RPC || DEFAULT_BASE_RPC, { commitment: "confirmed" }));

/** JSON for `/api/account/<authority>`. `fresh`: the Account just sent a transaction, so its lists are re-read upstream first. */
export async function getAccountState(authority: PublicKey, opts: { fresh?: boolean } = {}, deps: SnapshotDeps = { lists: getAccounts, connection: connection(), invalidate: invalidateAccountLists }): Promise<unknown> {
  if (opts.fresh) deps.invalidate();
  const state = await readAccountState(serverStateSource(deps), authority, BlockPuzzleChain.coreAccount(authority));
  return encodeState(state);
}
