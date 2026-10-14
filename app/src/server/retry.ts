const TRANSIENT = /exceeds defined limit|rate.?limit|too many requests|took too long|timed? ?out|unknown RPC error|fetch failed|network|socket hang up|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i;
const TRANSIENT_CODES = new Set<unknown>([-32005, "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"]);

/** A rate limit, timeout or network error: the same read may well succeed a moment later. A refusal or a program error never does. */
export function isTransient(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  const err = e as { status?: number; code?: unknown; shortMessage?: string };
  if (err.status === 429 || err.status === 408 || (typeof err.status === "number" && err.status >= 502 && err.status <= 504)) return true;
  if (TRANSIENT_CODES.has(err.code)) return true;
  if (typeof err.status === "number" && err.status >= 400 && err.status < 500) return false;
  return TRANSIENT.test(`${err.shortMessage ?? ""} ${e.message}`);
}

/** Runs a server chain read, retrying transient errors a few times with a growing pause. Only for reads: a send must never be repeated blindly. */
export async function retryRead<T>(read: () => Promise<T>, opts: { tries?: number; delayMs?: number } = {}): Promise<T> {
  const tries = opts.tries ?? 4;
  const delay = opts.delayMs ?? 400;
  for (let attempt = 1; ; attempt++) {
    try {
      return await read();
    } catch (e) {
      if (attempt >= tries || !isTransient(e)) throw e;
      await new Promise((r) => setTimeout(r, delay * attempt));
    }
  }
}

const RETRIED_READS = new Set<PropertyKey>(["getAccountInfo", "getMultipleAccountsInfo", "getBalance", "getLatestBlockhash", "simulateTransaction"]);

/** `conn` whose read methods go through `retryRead`; sends and everything else pass straight through. */
export function retryingReads<T extends object>(conn: T): T {
  return new Proxy(conn, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (!RETRIED_READS.has(prop)) return value.bind(target);
      return (...args: unknown[]) => retryRead(() => value.apply(target, args));
    },
  });
}
