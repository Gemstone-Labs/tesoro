"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Sheet } from "@/components/ui";
import { useAuth } from "@/lib/auth/context";
import { SIM_MONTH_MIN } from "@/lib/chain/native";
import { backLink } from "@/lib/deposit/back-link";
import { onDeposit, type DepositIntent } from "@/lib/deposit/bus";
import { DEPOSIT_ACK_TITLE } from "@/lib/deposit/acknowledgment";
import { PACK_MONTHS } from "@/lib/deposit/packs";
import { CLUSTER } from "@/lib/cluster-settings";
import { writeViewMode } from "@/lib/deposit/view-mode";
import { AckView, DoneView, ErrorView, PacksView, WorkingView, type DepositArt } from "./DepositPanel";
import { useDepositFlow } from "./use-deposit-flow";

const TEST_MODE = CLUSTER.yieldModel !== "real";
const HOURS = (PACK_MONTHS * SIM_MONTH_MIN) / 60;
const ART_KEY = "tesoro:deposit-art";

/** The founders compare two art sets: the choice sticks in this browser. */
function useArt(): [DepositArt, (a: DepositArt) => void] {
  // The sheet's content only renders once opened in the browser, so reading storage here can't mismatch server markup.
  const [art, setArt] = useState<DepositArt>(() => {
    try {
      const v = localStorage.getItem(ART_KEY);
      return v === "a" || v === "b" ? v : "b";
    } catch {
      return "b";
    }
  });
  return [
    art,
    (a) => {
      setArt(a);
      try {
        localStorage.setItem(ART_KEY, a);
      } catch {
        // Not remembered.
      }
    },
  ];
}

/** The deposit modal: packs, the acknowledgment, progress, success. Controlled by `open`. */
export function DepositSheet({ open, onClose, intent }: { open: boolean; onClose: () => void; intent: DepositIntent | null }) {
  const flow = useDepositFlow(intent);
  const auth = useAuth();
  const router = useRouter();
  const [art, setArt] = useArt();
  const { step, picked, reset } = flow;
  // A finished or abandoned deposit starts over the next time the modal opens.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current && step !== "packs" && step !== "working") reset();
    wasOpen.current = open;
  }, [open, step, reset]);
  const goAdvanced = () => {
    const a = auth.signer?.publicKey.toBase58();
    if (a) writeViewMode(a, "advanced");
    onClose();
    router.push("/wallet");
  };

  return (
    <Sheet open={open} onClose={onClose} title={step === "ack" ? DEPOSIT_ACK_TITLE : "Get Gemas"} className="dep-sheet">
      {step === "packs" && (
        <PacksView
          quotes={flow.quotes}
          highlight={flow.highlight}
          art={art}
          onArt={setArt}
          canPay={flow.canPay}
          testMode={TEST_MODE}
          feePct={flow.feePct}
          checking={flow.checking}
          onPick={(id) => void flow.pick(id)}
          onAdvanced={goAdvanced}
        />
      )}
      {step === "ack" && picked && (
        <AckView
          pack={picked.pack}
          checked={flow.ack.checked}
          onChecked={flow.ack.setChecked}
          busy={flow.ack.busy}
          error={flow.ack.error}
          onConfirm={() => void flow.ack.confirm()}
          onBack={flow.back}
        />
      )}
      {step === "working" && picked && <WorkingView pack={picked.pack} phase={flow.phase} testMode={TEST_MODE} hours={HOURS} />}
      {step === "done" && flow.result && (
        <DoneView gemas={flow.result.gemas} back={backLink(intent)} onDone={onClose} testMode={TEST_MODE} hours={HOURS} />
      )}
      {step === "error" && picked && (
        <ErrorView pack={picked.pack} message={flow.error ?? "That didn’t go through. Try again in a moment."} paidAlready={flow.paidAlready} onRetry={flow.retry} onClose={onClose} />
      )}
    </Sheet>
  );
}

/** Mounted once in the app shell: opens on `requestDeposit`, signing in first when needed. */
export function DepositHost() {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState<DepositIntent | null>(null);
  useEffect(
    () =>
      onDeposit((next) =>
        auth.gate("deposit", () => {
          setIntent(next);
          setOpen(true);
        }),
      ),
    [auth],
  );
  return <DepositSheet open={open} onClose={() => setOpen(false)} intent={intent} />;
}
