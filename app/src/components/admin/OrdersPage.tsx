"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/context";
import { fetchOrders } from "@/lib/chain/admin-client";
import { fillOrder } from "@/lib/chain/admin-fill";
import { plainError } from "@/lib/errors";
import type { AdminOrder, OrdersReply } from "@/server/admin/orders";
import { OrdersView } from "./OrdersView";

/** Signs one request with the signed-in wallet; the server decides whether it is an admin. A fill is sent from the same wallet. */
export function OrdersPage() {
  const auth = useAuth();
  const signer = auth.signer;
  const [reply, setReply] = useState<OrdersReply | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ address: string; ok: boolean; text: string } | null>(null);

  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!signer) return;
    let live = true;
    fetchOrders(signer, auth.getAccessToken)
      .then((r) => {
        if (!live) return;
        setReply(r);
        setError(null);
      })
      .catch((e) => live && setError(plainError(e)));
    return () => {
      live = false;
    };
  }, [signer, auth.getAccessToken, tick]);

  const onFill = async (order: AdminOrder, gemas: bigint) => {
    if (!signer) return;
    setBusy(order.address);
    setResult(null);
    try {
      const sig = await fillOrder(signer, order, gemas);
      setResult({ address: order.address, ok: true, text: `Filled ${gemas} Gemas. ${sig.slice(0, 8)}…` });
      setTick((t) => t + 1);
    } catch (e) {
      setResult({ address: order.address, ok: false, text: plainError(e) });
    } finally {
      setBusy(null);
    }
  };

  return <OrdersView reply={reply} error={error} signedOut={!signer} busy={busy} result={result} onFill={(o, g) => void onFill(o, g)} />;
}
