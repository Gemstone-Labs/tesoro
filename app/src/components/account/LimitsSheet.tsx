"use client";

import { useEffect, useState } from "react";
import { Sheet } from "@/components/ui";
import { useAuth } from "@/lib/auth/context";
import { fetchEntryLimit, entryLimitView, type EntryLimitData } from "@/lib/chain/entry-limit";
import { fetchExtendLimit, extendLimitView, type ExtendLimitData } from "@/lib/chain/extend-limit";
import { getChain } from "@/lib/chain/client";
import { setEntryLimit, setExtendLimit } from "@/lib/chain/native-flow";
import { useNowSecs } from "@/lib/chain/useNowSecs";
import { plainError } from "@/lib/errors";
import { setLimitsOpen, useLimitsOpen } from "@/lib/identity/limits-sheet";
import { LimitsView } from "./Limits";
import "@/app/(app)/wallet/advance-sheet.css";

/** Mounted once in the shell, opened from the Account menu. */
export function LimitsSheet() {
  const open = useLimitsOpen();
  return (
    <Sheet open={open} onClose={() => setLimitsOpen(false)} title="Limits">
      {open && <LimitsPanel />}
    </Sheet>
  );
}

function LimitsPanel() {
  const auth = useAuth();
  const owner = auth.signer?.publicKey;
  const key = owner?.toBase58();
  const now = useNowSecs(5000);
  const [entry, setEntry] = useState<EntryLimitData | "unknown" | undefined>(undefined);
  const [extend, setExtend] = useState<ExtendLimitData | "unknown" | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!owner) return;
    let live = true;
    const base = getChain().base;
    void fetchEntryLimit(base, owner).catch((): "unknown" => "unknown").then((l) => live && setEntry(l));
    void fetchExtendLimit(base, owner).catch((): "unknown" => "unknown").then((l) => live && setExtend(l));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  async function run(name: string, send: () => Promise<unknown>) {
    setError(null);
    setBusy(name);
    try {
      await send();
      setTick((t) => t + 1);
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(null);
    }
  }

  const reload = () => {
    setEntry(undefined);
    setExtend(undefined);
    setTick((t) => t + 1);
  };
  return (
    <LimitsView
      entry={entry === undefined ? null : entry === "unknown" ? null : entryLimitView(entry, now)}
      extend={extend === undefined || extend === "unknown" ? null : extendLimitView(extend, now, 0)}
      busy={busy}
      error={error ?? (entry === "unknown" || extend === "unknown" ? "Couldn't read your limits. Try again." : null)}
      onRetry={reload}
      onSetEntry={(g) => auth.signer && void run("entry", () => setEntryLimit(auth.signer!, auth.getAccessToken, g))}
      onSetExtend={(m) => auth.signer && void run("extend", () => setExtendLimit(auth.signer!, auth.getAccessToken, m))}
    />
  );
}
