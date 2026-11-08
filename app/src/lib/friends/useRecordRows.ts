"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount } from "@/lib/account";
import { accountHistory, type HistoryRow } from "@/lib/chain/history";
import { fetchAllHistory } from "@/lib/chain/history-client";
import { recordRows } from "./record";

/** My Matches for head-to-head records (finished ones from the history plus live ones); null until both have been read. */
export function useRecordRows(): HistoryRow[] | null {
  const { snapshot } = useAccount();
  const key = snapshot?.accountKey.toBase58() ?? null;
  const [history, setHistory] = useState<{ key: string; rows: HistoryRow[] } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    // When the history is not available the record falls back to the live Matches it can see.
    void fetchAllHistory(key).then((rows) => live && setHistory({ key, rows: rows ?? [] }));
    return () => {
      live = false;
    };
  }, [key]);
  return useMemo(() => (snapshot && history && history.key === key ? recordRows(history.rows, accountHistory(snapshot.matches)) : null), [snapshot, history, key]);
}
