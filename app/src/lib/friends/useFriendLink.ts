"use client";

import { useCallback, useEffect, useState } from "react";
import { useFriends } from "./FriendsProvider";
import { loadLink, rememberedLink, replaceLink } from "./memory";

/** Your Friend link: fetched once per page load, reused on every later visit, replaced only by Reset link. */
export function useFriendLink(): { code: string | null; reset: () => Promise<void> } {
  const { me, status, act } = useFriends();
  const [code, setCode] = useState<string | null>(() => (me ? rememberedLink(me) : null));

  useEffect(() => {
    if (!me) return;
    const known = rememberedLink(me);
    if (known) {
      setCode(known);
      return;
    }
    if (status !== "ready") return;
    let stopped = false;
    loadLink(me, () => act("link").then((r) => r.code ?? null)).then(
      (c) => !stopped && setCode(c),
      () => undefined,
    );
    return () => {
      stopped = true;
    };
  }, [me, status, act]);

  const reset = useCallback(async () => {
    if (!me) return;
    setCode(await replaceLink(me, () => act("reset-link").then((r) => r.code ?? null)));
  }, [act, me]);

  return { code, reset };
}
