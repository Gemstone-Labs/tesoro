import type { ChainSigner } from "@/games/block-puzzle/chain";
import { PRESENCE_EVERY_MS } from "../../server/presence/lease";
import type { GetToken } from "./demo-client";
import { newNonce, signedMessage } from "./signed-request";

export { PRESENCE_EVERY_MS };

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** The opener of a Queue Match says "still here" (POST /api/queue/presence). Throws when the call fails. */
export async function touchPresence(signer: ChainSigner, getToken: GetToken, matchKey: string): Promise<void> {
  const address = signer.publicKey.toBase58();
  const ts = Date.now();
  const nonce = newNonce();
  const signature = await signer.signMessage(new TextEncoder().encode(signedMessage("tesoro-presence", "touch", address, ts, nonce, { match: matchKey })));
  const token = await getToken().catch(() => null);
  const res = await fetch("/api/queue/presence", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ step: "touch", address, ts, nonce, match: matchKey, signature: b64(signature) }),
  });
  if (!res.ok) throw new Error("presence");
}

/** The Matches among `ids` with a fresh lease, or null when the call fails (callers then do not filter). */
export async function freshLeases(ids: string[], fetcher: typeof fetch = fetch): Promise<Set<string> | null> {
  if (ids.length === 0) return new Set();
  try {
    const out = new Set<string>();
    for (let i = 0; i < ids.length; i += 100) {
      const res = await fetcher(`/api/queue/presence?ids=${ids.slice(i, i + 100).map(encodeURIComponent).join(",")}`, { cache: "no-store" });
      if (!res.ok) return null;
      const json = (await res.json()) as { fresh?: unknown };
      if (!Array.isArray(json.fresh)) return null;
      for (const k of json.fresh) if (typeof k === "string") out.add(k);
    }
    return out;
  } catch {
    return null;
  }
}

/** `ids` without those that lack a fresh lease; `fresh` null (the check failed) keeps them all. */
export const filterByLease = <T extends string>(ids: readonly T[], fresh: ReadonlySet<string> | null): T[] => (fresh ? ids.filter((id) => fresh.has(id)) : [...ids]);

type PageEvents = Pick<Document, "addEventListener" | "removeEventListener"> & { visibilityState: DocumentVisibilityState };
const pageEvents = (): PageEvents | undefined => (typeof document === "undefined" ? undefined : document);

/**
 * Calls `touch` now, every `everyMs`, and again the moment the page becomes visible. A page in the background or on a phone
 * with its screen off has its timers throttled or frozen, so its lease runs out; touching on return shortens that gap to
 * one round trip.
 */
export function startPresenceLoop(touch: () => Promise<unknown>, everyMs: number = PRESENCE_EVERY_MS, page: PageEvents | undefined = pageEvents()): () => void {
  let stopped = false;
  const once = () => {
    if (!stopped) touch().catch(() => undefined);
  };
  const onVisible = () => {
    if (page?.visibilityState === "visible") once();
  };
  once();
  const t = setInterval(once, everyMs);
  page?.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    clearInterval(t);
    page?.removeEventListener("visibilitychange", onVisible);
  };
}

interface WakeLockSentinelLike {
  release(): Promise<void>;
}
type NavigatorWithWakeLock = { wakeLock?: { request(type: "screen"): Promise<WakeLockSentinelLike> } };

/**
 * Keeps the screen on while a Player waits in the Queue: a phone that dims its screen suspends the page, the presence lease
 * runs out, and the Match stops being offered to the next Player. The browser drops the lock whenever the page is hidden,
 * so it is taken again on return. Returns the function that lets go. Does nothing where the browser has no Wake Lock.
 */
export function keepScreenAwake(nav: NavigatorWithWakeLock | undefined = typeof navigator === "undefined" ? undefined : navigator, page: PageEvents | undefined = pageEvents()): () => void {
  if (!nav?.wakeLock) return () => undefined;
  let lock: WakeLockSentinelLike | null = null;
  let stopped = false;
  const take = () => {
    if (stopped || page?.visibilityState === "hidden") return;
    nav.wakeLock!
      .request("screen")
      .then((l) => {
        if (stopped) void l.release().catch(() => undefined);
        else lock = l;
      })
      .catch(() => undefined);
  };
  take();
  page?.addEventListener("visibilitychange", take);
  return () => {
    stopped = true;
    page?.removeEventListener("visibilitychange", take);
    void lock?.release().catch(() => undefined);
  };
}
