/**
 * The seat key manager: one key per Match, made on the Player's device. The wallet signs the entry once and names the key; the
 * key then plays that Match (moves, rollup login, Queue presence, finish requests) so the wallet is not asked again.
 *
 * Keys are stored by Match key (`<opener Account>-<n>`, known before the Match exists: an opener's `n` is its counter, a joiner
 * knows the Match it joins), so a reload at any point finds the same key. WebCrypto Ed25519 keeps the private key non-extractable
 * in IndexedDB; where the browser has no Ed25519 a tweetnacl key is stored instead (the same power: it can only play a Match
 * its wallet already entered). A key is deleted when its Match closes, and keys of entries that never landed are pruned.
 */
import { PublicKey, VersionedTransaction, type Transaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { matchAddressOf } from "@/lib/chain/match-id";

export type SeatKeyKind = "webcrypto" | "software";

/** A seat key as a signer. `publicKey` is the key named in the entry; the wallet it acts for is `wallet`. */
export interface SeatKey extends ChainSigner {
  signSerialized(tx: Uint8Array): Promise<Uint8Array>;
  readonly kind: SeatKeyKind;
  readonly matchKey: string;
  readonly wallet: PublicKey;
  readonly seatMatch: PublicKey;
  readonly seatMatchKey: string;
}

interface StoredKey {
  matchKey: string;
  /** The wallet the entry was signed with: another wallet on the same device never gets this key. */
  wallet: string;
  publicKey: string;
  createdAt: number;
  kind: SeatKeyKind;
  /** `CryptoKey` (webcrypto) or the 64-byte nacl secret key (software). */
  secret: CryptoKey | Uint8Array;
}

/** Where keys live. IndexedDB in the browser; a Map in tests and where IndexedDB is unavailable. */
export interface SeatKeyStore {
  get(matchKey: string): Promise<StoredKey | undefined>;
  put(key: StoredKey): Promise<void>;
  delete(matchKey: string): Promise<void>;
  list(): Promise<StoredKey[]>;
}

export function memorySeatKeyStore(): SeatKeyStore {
  const map = new Map<string, StoredKey>();
  // structuredClone like IndexedDB, so a stored CryptoKey is a copy and not shared state
  return {
    get: async (k) => (map.has(k) ? structuredClone(map.get(k)!) : undefined),
    put: async (key) => void map.set(key.matchKey, structuredClone(key)),
    delete: async (k) => void map.delete(k),
    list: async () => [...map.values()].map((v) => structuredClone(v)),
  };
}

const DB = "tesoro-seat-keys";
const STORE = "keys";

const request = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export function indexedDbSeatKeyStore(factory: IDBFactory): SeatKeyStore {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const r = factory.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "matchKey" });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  const run = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await request(f(db.transaction(STORE, mode).objectStore(STORE)));
    } finally {
      db.close();
    }
  };
  return {
    get: (k) => run("readonly", (s) => s.get(k) as IDBRequest<StoredKey | undefined>),
    put: async (key) => void (await run("readwrite", (s) => s.put(key))),
    delete: async (k) => void (await run("readwrite", (s) => s.delete(k))),
    list: () => run("readonly", (s) => s.getAll() as IDBRequest<StoredKey[]>),
  };
}

/** The browser's store, or a memory one when IndexedDB is missing or blocked (a private window): a reload then plays with the wallet. */
export function browserSeatKeyStore(): SeatKeyStore {
  try {
    if (typeof indexedDB !== "undefined") return indexedDbSeatKeyStore(indexedDB);
  } catch {
    /* blocked: fall through */
  }
  return memorySeatKeyStore();
}

function signerOf(stored: StoredKey, subtle: SubtleCrypto | undefined): SeatKey {
  const seatMatch = matchAddressOf(stored.matchKey);
  if (!seatMatch) throw new Error(`Not a Match key: ${stored.matchKey}`);
  const publicKey = new PublicKey(stored.publicKey);
  const signMessage = async (message: Uint8Array): Promise<Uint8Array> => {
    if (stored.kind === "software") return nacl.sign.detached(message, stored.secret as Uint8Array);
    if (!subtle) throw new Error("This browser cannot use the saved key.");
    return new Uint8Array(await subtle.sign("Ed25519", stored.secret as CryptoKey, message as BufferSource));
  };
  return {
    publicKey,
    kind: stored.kind,
    matchKey: stored.matchKey,
    wallet: new PublicKey(stored.wallet),
    signMessage,
    signTransaction: async <T extends Transaction>(tx: T): Promise<T> => {
      tx.addSignature(publicKey, Buffer.from(await signMessage(tx.serializeMessage())));
      return tx;
    },
    signSerialized: async (raw) => signInto(raw, publicKey, signMessage),
    seatMatch,
    seatMatchKey: stored.matchKey,
  };
}

/** Puts `key`'s signature on a serialized transaction (either version), in the slot where the message requires it. */
export async function signInto(raw: Uint8Array, key: PublicKey, sign: (m: Uint8Array) => Promise<Uint8Array>): Promise<Uint8Array> {
  const tx = VersionedTransaction.deserialize(raw);
  const required = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
  const at = required.findIndex((k) => k.equals(key));
  if (at < 0) return raw;
  tx.signatures[at] = await sign(tx.message.serialize());
  return tx.serialize();
}

export interface SeatKeyDeps {
  store: SeatKeyStore;
  subtle?: SubtleCrypto;
  now?: () => number;
}

const defaultSubtle = () => (typeof crypto !== "undefined" ? crypto.subtle : undefined);

export class SeatKeyManager {
  private readonly store: SeatKeyStore;
  private readonly subtle: SubtleCrypto | undefined;
  private readonly now: () => number;
  /** One creation at a time per Match: two callers (a retry, a second render) get the same key. */
  private readonly making = new Map<string, Promise<SeatKey>>();

  constructor(deps: SeatKeyDeps) {
    this.store = deps.store;
    this.subtle = "subtle" in deps ? deps.subtle : defaultSubtle();
    this.now = deps.now ?? Date.now;
  }

  /** The key of this device for the Match, made now when there is none. */
  forMatch(matchKey: string, wallet: PublicKey): Promise<SeatKey> {
    const pending = this.making.get(matchKey);
    if (pending) return pending;
    const p = this.getOrCreate(matchKey, wallet).finally(() => this.making.delete(matchKey));
    this.making.set(matchKey, p);
    return p;
  }

  /** The key this device holds for the Match and wallet, or null (another device made it, or it was deleted). */
  async find(matchKey: string, wallet: PublicKey): Promise<SeatKey | null> {
    const stored = await this.store.get(matchKey).catch(() => undefined);
    return stored && stored.wallet === wallet.toBase58() ? signerOf(stored, this.subtle) : null;
  }

  /** Deletes the key: the Match is closed (or the entry never happened). */
  async release(matchKey: string): Promise<void> {
    await this.store.delete(matchKey).catch(() => undefined);
  }

  /** Match keys that have a key on this device. */
  async held(): Promise<{ matchKey: string; publicKey: string; wallet: string; createdAt: number }[]> {
    return (await this.store.list().catch(() => [])).map(({ matchKey, publicKey, wallet, createdAt }) => ({ matchKey, publicKey, wallet, createdAt }));
  }

  /**
   * Deletes the keys whose Match is over or never happened. `status` says what the chain shows for a Match key and this key:
   * `named` (the Match exists and names the key), `unnamed` (it exists or is closed and does not), `unknown` (could not read).
   * A key younger than `graceMs` is kept: its entry may still be on its way.
   */
  async prune(status: (matchKey: string, publicKey: string) => Promise<"named" | "unnamed" | "unknown">, graceMs = 15 * 60_000): Promise<string[]> {
    const gone: string[] = [];
    for (const k of await this.held()) {
      if (this.now() - k.createdAt < graceMs) continue;
      if ((await status(k.matchKey, k.publicKey).catch(() => "unknown" as const)) === "unnamed") {
        await this.release(k.matchKey);
        gone.push(k.matchKey);
      }
    }
    return gone;
  }

  private async getOrCreate(matchKey: string, wallet: PublicKey): Promise<SeatKey> {
    const have = await this.find(matchKey, wallet);
    if (have) return have;
    const stored = await this.make(matchKey, wallet);
    await this.store.put(stored);
    return signerOf(stored, this.subtle);
  }

  private async make(matchKey: string, wallet: PublicKey): Promise<StoredKey> {
    const base = { matchKey, wallet: wallet.toBase58(), createdAt: this.now() };
    const subtle = this.subtle;
    if (subtle) {
      try {
        const pair = (await subtle.generateKey("Ed25519", false, ["sign", "verify"])) as CryptoKeyPair;
        const raw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
        return { ...base, kind: "webcrypto", publicKey: new PublicKey(raw).toBase58(), secret: pair.privateKey };
      } catch {
        /* no Ed25519 in this browser: a software key does the same job */
      }
    }
    const kp = nacl.sign.keyPair();
    return { ...base, kind: "software", publicKey: new PublicKey(kp.publicKey).toBase58(), secret: kp.secretKey };
  }
}

let shared: SeatKeyManager | undefined;
/** The page's manager, on the browser's store. */
export function seatKeys(): SeatKeyManager {
  return (shared ??= new SeatKeyManager({ store: browserSeatKeyStore() }));
}
export function setSeatKeysForTest(m: SeatKeyManager | undefined) {
  shared = m;
}
