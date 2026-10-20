/** Answers that mean the RPC is briefly unavailable, not that the request was wrong. */
const OUTAGE = new Set([502, 503, 504]);

export interface RpcFetchOptions {
  /** Endpoint for the last try, when the primary keeps failing. */
  fallback?: string;
  tries?: number;
  delayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * The browser's RPC fetch. A 502/503/504 or a dropped connection is retried (web3.js only retries 429),
 * the last try goes to `fallback` when set, and no request waits longer than `timeoutMs`.
 */
export function rpcFetch({ fallback, tries = 3, delayMs = 400, timeoutMs = 20_000, fetchImpl = fetch }: RpcFetchOptions = {}): typeof fetch {
  return async (input, init) => {
    for (let i = 0; ; i++) {
      const last = i === tries - 1;
      try {
        const res = await fetchImpl(last && fallback ? fallback : input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
        if (last || !OUTAGE.has(res.status)) return res;
      } catch (e) {
        // A timeout or abort is final; only a network failure (TypeError) is worth another try.
        if (last || !(e instanceof TypeError)) throw e;
      }
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  };
}
