"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAccount } from "@/lib/account";
import { accountKeyOf } from "@/lib/chain/account-key";
import { FriendsError, friendsCall, startFriendsSession, type FriendsResult, type FriendsView } from "./client";

/** How one Account stands with me. `unknown` until the list has loaded. */
export type Relation = "self" | "friend" | "sent" | "incoming" | "none" | "unknown";

export interface FriendsState {
  /** `locked`: signed in, no Friends session on this browser yet; the provider starts one on its own (the embedded wallet signs without a prompt). */
  status: "signed-out" | "locked" | "loading" | "ready" | "error";
  view: FriendsView | null;
  me: string | null;
  error: string | null;
  /** Starts a session if needed (the embedded wallet signs in the background), then loads the list. */
  unlock: () => Promise<boolean>;
  refresh: () => Promise<void>;
  /** Runs one action (starting a session first if needed) and reloads the list. */
  act: (op: string, args?: Record<string, unknown>) => Promise<FriendsResult>;
  relation: (account: string) => Relation;
}

/** Outside the app shell (docs, tests, stories): no Friends, nothing to do. */
const NONE: FriendsState = {
  status: "signed-out",
  view: null,
  me: null,
  error: null,
  unlock: async () => false,
  refresh: async () => undefined,
  act: async () => {
    throw new Error("Friends are not available here.");
  },
  relation: () => "unknown",
};

const Ctx = createContext<FriendsState>(NONE);
const POLL_MS = 60_000;

export function FriendsProvider({ children }: { children: ReactNode }) {
  const { auth, snapshot } = useAccount();
  const signer = auth.signer;
  const me = useMemo(
    () => (auth.status !== "signed-in" ? null : (snapshot?.accountKey.toBase58() ?? (auth.addresses.solana ? accountKeyOf(auth.addresses.solana) : null))),
    [auth.status, snapshot, auth.addresses.solana],
  );
  // Everything loaded belongs to one Account (`of`); after a sign-out or a switch it simply stops counting.
  const [st, setSt] = useState<{ of: string | null; status: "locked" | "loading" | "ready" | "error"; view: FriendsView | null; error: string | null }>({
    of: null,
    status: "loading",
    view: null,
    error: null,
  });
  const mine = me !== null && st.of === me;
  // Sign-in still settling (or the wallet address not known yet) is loading, never signed out.
  const settling = auth.status === "loading" || (auth.status === "signed-in" && !me);
  const status: FriendsState["status"] = settling ? "loading" : !me ? "signed-out" : mine ? st.status : "loading";
  const view = mine ? st.view : null;
  const error = mine ? st.error : null;
  const getToken = auth.getAccessToken;
  const unlocking = useRef<Promise<boolean> | null>(null);

  /** Reads the list for `who`; a session for another Account (a different sign-in on this browser) counts as none. */
  const read = useCallback(
    async (who: string): Promise<FriendsView | null> => {
      try {
        const v = (await friendsCall("list", {}, getToken)) as FriendsView;
        return v.me === who ? v : null;
      } catch (e) {
        if (e instanceof FriendsError && e.code === "no-session") return null;
        throw e;
      }
    },
    [getToken],
  );
  const failed = (who: string, e: unknown) => setSt({ of: who, status: "error", view: null, error: e instanceof Error ? e.message : String(e) });
  const shown = (who: string, v: FriendsView | null) => setSt({ of: who, status: v ? "ready" : "locked", view: v, error: null });
  /** Reads and shows the list; true when a session was there. */
  const load = useCallback(
    async (who: string): Promise<boolean> => {
      const v = await read(who);
      setSt({ of: who, status: v ? "ready" : "locked", view: v, error: null });
      return v !== null;
    },
    [read],
  );

  // On sign-in, use a session this browser already has; without one, start one below.
  useEffect(() => {
    if (!me) return;
    read(me).then(
      (v) => shown(me, v),
      (e) => failed(me, e),
    );
  }, [me, read]);

  useEffect(() => {
    if (status !== "ready" || !me) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void load(me).catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(t);
  }, [status, me, load]);

  const unlock = useCallback(async (): Promise<boolean> => {
    if (!signer || !me) return false;
    unlocking.current ??= (async () => {
      try {
        if (await load(me)) return true;
        setSt({ of: me, status: "loading", view: null, error: null });
        await startFriendsSession(signer, getToken);
        return await load(me);
      } catch (e) {
        failed(me, e);
        return false;
      } finally {
        unlocking.current = null;
      }
    })();
    return unlocking.current;
  }, [signer, me, getToken, load]);

  // The Account's embedded wallet signs in the background (no wallet UI), so a session starts as soon as
  // the wallet exists, once per Account; after a failure, the Friends page offers Try again.
  const tried = useRef<string | null>(null);
  useEffect(() => {
    if (!me || !signer || st.of !== me || st.status !== "locked" || tried.current === me) return;
    tried.current = me;
    void unlock();
  }, [me, signer, st.of, st.status, unlock]);

  const act = useCallback(
    async (op: string, args: Record<string, unknown> = {}): Promise<FriendsResult> => {
      const run = () => friendsCall(op, args, getToken) as Promise<FriendsResult>;
      let r: FriendsResult;
      try {
        r = await run();
      } catch (e) {
        if (!(e instanceof FriendsError && e.code === "no-session")) throw e;
        if (!(await unlock())) throw e;
        r = await run();
      }
      if (me) await load(me).catch(() => undefined);
      return r;
    },
    [getToken, unlock, load, me],
  );

  const relation = useCallback(
    (account: string): Relation => {
      if (account === me) return "self";
      if (!view) return "unknown";
      if (view.friends.some((f) => f.account === account)) return "friend";
      if (view.incoming.some((r) => r.account === account)) return "incoming";
      if (view.outgoing.some((r) => r.account === account)) return "sent";
      return "none";
    },
    [view, me],
  );

  const refresh = useCallback(async () => {
    if (me) await load(me).catch(() => undefined);
  }, [me, load]);
  const value = useMemo<FriendsState>(() => ({ status, view, me, error, unlock, refresh, act, relation }), [status, view, me, error, unlock, refresh, act, relation]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useFriends = (): FriendsState => useContext(Ctx);
