import type { AccountInfo, PublicKey } from "@solana/web3.js";

/** The part of a rollup connection the feed uses. */
export interface FeedConnection {
  getAccountInfo(address: PublicKey): Promise<AccountInfo<Buffer> | null>;
  onAccountChange(address: PublicKey, cb: (info: AccountInfo<Buffer>) => void): number;
  removeAccountChangeListener(id: number): Promise<void>;
}

export interface FeedOptions<T> {
  conn: FeedConnection;
  address: PublicKey;
  decode: (info: AccountInfo<Buffer>) => T | null;
  onValue: (value: T) => void;
  /** A read is made when the websocket has been silent this long. The table is also silent by design from the freeze. */
  pollMs?: number;
  now?: () => number;
  onError?: (e: unknown) => void;
}

/**
 * Keeps one account fresh: the websocket pushes changes; whenever it has been quiet for `pollMs` a read is made as well, so a
 * dead or silent socket costs at most that. Returns the stop function.
 */
export function watchAccount<T>(o: FeedOptions<T>): () => void {
  const pollMs = o.pollMs ?? 1_000;
  const now = o.now ?? Date.now;
  let last = 0;
  let stopped = false;
  let reading = false;
  const deliver = (info: AccountInfo<Buffer> | null) => {
    if (stopped || !info) return;
    const v = o.decode(info);
    if (v === null) return;
    last = now();
    o.onValue(v);
  };
  let sub: number | null = null;
  try {
    sub = o.conn.onAccountChange(o.address, (info) => deliver(info));
  } catch (e) {
    o.onError?.(e);
  }
  const poll = async () => {
    if (stopped || reading || now() - last < pollMs) return;
    reading = true;
    try {
      deliver(await o.conn.getAccountInfo(o.address));
    } catch (e) {
      o.onError?.(e);
    } finally {
      reading = false;
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), Math.max(250, Math.floor(pollMs / 2)));
  return () => {
    stopped = true;
    clearInterval(timer);
    if (sub !== null) void o.conn.removeAccountChangeListener(sub).catch(() => undefined);
  };
}
