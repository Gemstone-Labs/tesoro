"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { ChainSigner } from "./chain";
import { getBurst } from "@/lib/chain/client";
import { fetchMatch } from "@/lib/chain/read";
import { BurstDriver, initialBurstView } from "./burst-driver";

export { tableStage, type BurstView, type Stage } from "./burst-driver";

const noop = () => undefined;
const idle = initialBurstView();

/** Runs one Block Burst Match for this Player (`BurstDriver`) and hands the screen its view. */
export function useBurstMatch(id: string | null, signer: ChainSigner | null, accountKey: string | null, onSettled?: () => void) {
  // One driver per Match and wallet; a new signer object or callback for the same wallet does not restart it.
  const wallet = signer?.publicKey.toBase58() ?? null;
  const driver = useMemo(
    () => (id !== null && signer ? new BurstDriver({ id, signer, accountKey, chain: getBurst(), fetchMatch, onSettled }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `update` below keeps the driver's signer and callbacks current
    [id, wallet],
  );
  useEffect(() => {
    if (!driver || !signer) return;
    driver.update({ signer, accountKey, onSettled });
  });
  useEffect(() => {
    if (!driver) return;
    driver.start();
    return () => driver.stop();
  }, [driver]);
  const view = useSyncExternalStore(driver?.subscribe ?? noop as never, driver?.snapshot ?? (() => idle), () => idle);
  return { view, tick: () => driver?.tick() };
}
