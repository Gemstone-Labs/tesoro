"use client";

import { PublicKey } from "@solana/web3.js";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/lib/auth/context";
import { callListing } from "@/lib/chain/admin-client";
import { listGame, readStanding, type GameStanding } from "@/lib/chain/admin-listing";
import { plainError } from "@/lib/errors";
import type { AdminReply, StudioApplication } from "@/server/listing/service";
import { ListingView, type ListingAction } from "./ListingView";

/** Signs each request with the signed-in wallet; the server decides whether it is an admin. Listing on chain is sent from the same wallet. */
export function ListingPage() {
  const auth = useAuth();
  const signer = auth.signer;
  const [reply, setReply] = useState<AdminReply | null>(null);
  const [standing, setStanding] = useState<Record<string, GameStanding>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [result, setResult] = useState<{ id: number; ok: boolean; text: string } | null>(null);

  const show = useCallback(async (r: AdminReply) => {
    setReply(r);
    setError(null);
    const accepted = r.applications.filter((a) => a.status === "accepted");
    const entries = await Promise.all(accepted.map(async (a) => [a.programId, await readStanding(new PublicKey(a.programId)).catch(() => null)] as const));
    setStanding(Object.fromEntries(entries.filter((e): e is readonly [string, GameStanding] => e[1] !== null)));
  }, []);

  const apply = useCallback(
    async (step: Parameters<typeof callListing>[2], fields: Parameters<typeof callListing>[3]) => {
      if (!signer) return;
      await show(await callListing(signer, auth.getAccessToken, step, fields));
    },
    [signer, auth.getAccessToken, show],
  );

  useEffect(() => {
    if (!signer) return;
    let live = true;
    callListing(signer, auth.getAccessToken, "studios")
      .then((r) => (live ? show(r) : undefined))
      .catch((e) => live && setError(plainError(e)));
    return () => {
      live = false;
    };
  }, [signer, auth.getAccessToken, show]);

  const onAction = async (app: StudioApplication, action: ListingAction) => {
    if (!signer) return;
    setBusy(app.id);
    setResult(null);
    try {
      if (action.kind === "accept" || action.kind === "reject") {
        await apply("studio-decide", { id: app.id, intent: action.kind === "accept" ? "accepted" : "rejected", code: action.note ?? "" });
      } else if (action.kind === "pay") {
        await apply("studio-pay", { id: app.id, version: action.payment, code: action.reference, months: action.years, position: String(action.amountUsd) });
      } else if (action.kind === "feature") {
        await apply("studio-feature", { id: app.id, enabled: action.on ? 1 : 0 });
      } else if (action.kind === "list") {
        if (!app.paidUntil) throw new Error("Record the yearly payment first.");
        const sig = await listGame(signer, new PublicKey(app.programId), app.paidUntil);
        setResult({ id: app.id, ok: true, text: `Listed on chain. ${sig.slice(0, 8)}…` });
        await apply("studios", {});
        return;
      }
      setResult({ id: app.id, ok: true, text: "Saved." });
    } catch (e) {
      setResult({ id: app.id, ok: false, text: plainError(e) });
    } finally {
      setBusy(null);
    }
  };

  return <ListingView reply={reply} standing={standing} error={error} signedOut={!signer} busy={busy} result={result} onAction={(a, act) => void onAction(a, act)} />;
}
