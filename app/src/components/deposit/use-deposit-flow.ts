"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useAccount } from "@/lib/account";
import { activeCheckout } from "@/lib/deposit/checkout";
import { DEPOSIT_PACKS, packFor, packMarket, quotePack, type DepositPackId, type PackQuote } from "@/lib/deposit/packs";
import { runPackDeposit, type DepositPhase, type DepositProgress } from "@/lib/deposit/run-deposit";
import type { DepositIntent } from "@/lib/deposit/bus";
import { plainError } from "@/lib/errors";
import { confirmDepositAck, readDepositAckCache, writeDepositAckCache } from "./ack";
import { confirmThenPay } from "@/lib/deposit/confirm-ack";

export type DepositStep = "packs" | "ack" | "working" | "done" | "error";

/**
 * The deposit modal's state: pick a pack, confirm the acknowledgment (unless the Player asked not to see it again), pay, add the deposit. A failed try keeps
 * what already worked, so Try again never asks for the money twice.
 */
export function useDepositFlow(intent: DepositIntent | null) {
  const { auth, snapshot, refresh, gemas } = useAccount();
  const [step, setStep] = useState<DepositStep>("packs");
  const [pickedId, setPickedId] = useState<DepositPackId | null>(null);
  const [phase, setPhase] = useState<DepositPhase>("paying");
  const [error, setError] = useState<string | null>(null);
  const [ackError, setAckError] = useState<string | null>(null);
  const [ackBusy, setAckBusy] = useState(false);
  const [ackChecked, setAckChecked] = useState(false);
  const [paidAlready, setPaidAlready] = useState(false);
  const [result, setResult] = useState<{ gemas: number; packId: DepositPackId } | null>(null);
  const progress = useRef<DepositProgress & { quoteKey: string }>({ funded: false, quoteKey: "" });

  const checkout = activeCheckout();
  const market = snapshot?.market ?? null;
  const pm = packMarket(market);
  const quotes: PackQuote[] | null = useMemo(
    () => (pm ? DEPOSIT_PACKS.map((p) => quotePack(p, pm, checkout?.feeBps ?? 0)) : null),
    // packMarket builds a new object each render; its inputs are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pm?.priceMicroUsd, pm?.apyBps, checkout?.feeBps],
  );
  const shortfall = intent?.need ? Math.max(0, intent.need - gemas.available) : 0;
  const highlight = quotes ? packFor(shortfall, quotes) : null;
  const picked = quotes?.find((q) => q.pack.id === pickedId) ?? null;
  const authority = auth.signer?.publicKey.toBase58() ?? null;

  const reset = useCallback(() => {
    setStep("packs");
    setPickedId(null);
    setError(null);
    setAckError(null);
    setAckChecked(false);
    setResult(null);
  }, []);

  const pay = useCallback(
    async (quote: PackQuote) => {
      const signer = auth.signer;
      if (!signer || !market) {
        setError("Your wallet isn't ready yet. Try again in a moment.");
        setStep("error");
        return;
      }
      const key = `${quote.pack.id}:${quote.lockLamports}`;
      if (progress.current.quoteKey !== key) progress.current = { funded: false, quoteKey: key };
      setError(null);
      setPhase("paying");
      setStep("working");
      try {
        const done = await runPackDeposit({ signer, getToken: auth.getAccessToken, market }, quote, progress.current, setPhase);
        setPaidAlready(false);
        progress.current = { funded: false, quoteKey: "" };
        setResult({ gemas: done.gemas, packId: quote.pack.id });
        setStep("done");
        void refresh();
      } catch (e) {
        setError(plainError(e));
        setPaidAlready(progress.current.funded);
        setStep("error");
        void refresh();
      }
    },
    [auth.signer, auth.getAccessToken, market, refresh],
  );

  /** The acknowledgment step shows until the Player ticked "Don't show this again" on an earlier deposit. */
  const pick = useCallback(
    (id: DepositPackId) => {
      const quote = quotes?.find((q) => q.pack.id === id);
      if (!quote || !auth.signer || !authority) return;
      setPickedId(id);
      if (readDepositAckCache(authority)) return void pay(quote);
      setAckChecked(false);
      setAckError(null);
      setStep("ack");
    },
    [quotes, auth.signer, authority, pay],
  );

  /** "I understand": always recorded on the server first; the deposit only goes on once that worked. */
  const confirmAck = useCallback(async () => {
    const signer = auth.signer;
    if (!signer || !authority || !picked) return;
    setAckBusy(true);
    setAckError(null);
    const failed = await confirmThenPay({
      confirm: () => confirmDepositAck(signer, auth.getAccessToken),
      dontShowAgain: ackChecked,
      rememberDontShow: () => writeDepositAckCache(authority),
      pay: () => void pay(picked),
    });
    setAckBusy(false);
    if (failed) setAckError(plainError(failed.error));
  }, [auth.signer, auth.getAccessToken, authority, picked, ackChecked, pay]);

  const retry = useCallback(() => {
    if (picked) void pay(picked);
  }, [picked, pay]);

  return {
    step, quotes, highlight, picked, phase, error, result,
    ack: { dontShow: ackChecked, setDontShow: setAckChecked, busy: ackBusy, error: ackError, confirm: confirmAck },
    canPay: checkout !== null,
    feePct: (checkout?.feeBps ?? 0) / 100,
    paidAlready,
    pick, retry, reset, back: () => setStep("packs"),
  };
}
