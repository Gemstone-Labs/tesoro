import type { DepositIntent } from "@/lib/deposit/bus";

/** Asks the open Advanced Vault to show its Buy Gemas sheet (the Vault’s Buy Gemas button, the top bar's Gemas pill). */
const bus = new EventTarget();
const EVENT = "get-gemas";

export function requestGetGemas(intent: DepositIntent | null = null) {
  bus.dispatchEvent(new CustomEvent<DepositIntent | null>(EVENT, { detail: intent }));
}

export function onGetGemas(cb: (intent: DepositIntent | null) => void) {
  const on = (e: Event) => cb((e as CustomEvent<DepositIntent | null>).detail ?? null);
  bus.addEventListener(EVENT, on);
  return () => bus.removeEventListener(EVENT, on);
}
