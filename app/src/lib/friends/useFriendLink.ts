"use client";

import { useCallback, useEffect, useState } from "react";
import { useFriends } from "./FriendsProvider";
import { loadLink, rememberedLink, replaceLink } from "./memory";

/** Your Friend link: fetched once per page load, reused on every later visit, replaced only by Reset link. */
export function useFriendLink(): { code: string | null; reset: () => Promise<void> } {
  const { me, status, act } = useFriends();
  const [fetched, setFetched] = useState<{ of: string; code: string | null } | null>(null);
  const code = me ? (rememberedLink(me) ?? (fetched?.of === me ? fetched.code : null)) : null;

  useEffect(() => {
    if (!me) return;
    if (rememberedLink(me)) return;
    if (status !== "ready") return;
    let stopped = false;
    loadLink(me, () => act("link").then((r) => r.code ?? null)).then(
      (c) => !stopped && setFetched({ of: me, code: c }),
      () => undefined,
    );
    return () => {
      stopped = true;
    };
  }, [me, status, act]);

  const reset = useCallback(async () => {
    if (!me) return;
    setFetched({ of: me, code: await replaceLink(me, () => act("reset-link").then((r) => r.code ?? null)) });
  }, [act, me]);

  return { code, reset };
}
