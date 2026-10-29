"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useAccount } from "@/lib/account";
import { DEFAULT_HORIZON_MONTHS } from "@/lib/advance";
import { vaultsOn, type EthVault } from "@/lib/chain/eth";
import type { DepositIntent } from "@/lib/deposit/bus";
import type { Chain } from "@/lib/mock";
import { EthOpenForm } from "./EthPositions";
import { NativeOpenForm } from "./NativePositions";
import { OpenFormView, OpenIntentContext, OpenPanel } from "./OpenPanel";

/** The Buy Gemas sheet's body in Pro view: chain tabs over the SOL, ETH and HYPE deposit forms. */
export function ProDepositBody({ intent, onDone }: { intent: DepositIntent | null; onDone: () => void }) {
  const { onChain, loading, snapshot } = useAccount();
  const router = useRouter();
  const [tab, setTab] = useState<Chain>("SOL");
  const [months, setMonths] = useState(DEFAULT_HORIZON_MONTHS);
  const market = snapshot?.market ?? null;
  const opened = (key: string) => router.push(`/wallet/opening?op=${encodeURIComponent(key)}`);
  return (
    <OpenIntentContext.Provider value={intent ? { game: intent.game, need: intent.need ?? null } : null}>
      <OpenPanel tab={tab} onTab={setTab}>
        {tab === "SOL" && (onChain ? <NativeOpenForm market={market} loading={loading} onDone={onDone} /> : <IdleForm unit="SOL" months={months} onMonths={setMonths} />)}
        {tab === "ETH" && (onChain ? <EthVaultForm unit="ETH" vault={vaultsOn("hoodi")[0]} onOpened={opened} /> : <IdleForm unit="ETH" months={months} onMonths={setMonths} />)}
        {tab === "HYPE" && (onChain ? <EthVaultForm unit="HYPE" vault={vaultsOn("hyperevm")[0]} onOpened={opened} /> : <IdleForm unit="HYPE" months={months} onMonths={setMonths} />)}
      </OpenPanel>
    </OpenIntentContext.Provider>
  );
}

/** The ETH and HYPE tabs: on the mainnet cluster a chain whose vault address is not set has nothing to open yet. */
function EthVaultForm({ unit, vault, onOpened }: { unit: "ETH" | "HYPE"; vault: EthVault | undefined; onOpened: (opKey: string) => void }) {
  if (!vault) return <p className="note">Locking {unit} is not available yet. It will appear here as soon as it is.</p>;
  return <EthOpenForm vault={vault} onOpened={onOpened} />;
}

/** The open form's shape before there is a market to quote from. */
function IdleForm({ unit, months, onMonths }: { unit: Chain; months: number; onMonths: (m: number) => void }) {
  return (
    <OpenFormView
      chain={unit}
      yieldText={`0 ${unit}`}
      inert
      amountText=""
      onAmount={() => undefined}
      months={months}
      onMonths={onMonths}
      gemas={null}
      estimate="—"
      note="Sign in to see your balance and a real quote."
      buttonLabel="Get Gemas"
      disabled
      onSubmit={() => undefined}
    />
  );
}
