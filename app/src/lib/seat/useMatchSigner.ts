"use client";

import { useEffect, useMemo, useState } from "react";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { useAccount } from "@/lib/account";
import { countingFor } from "./signature-counter";
import { seatKeys, type SeatKey } from "./seat-key";

/**
 * The signer of a Match page. Null while the device's key is still being looked up (`ready` false), so the wallet is never asked
 * to log in to the rollup just before the key is found. Then the Match's seat key, with the wallet behind it for the
 * base-layer steps the relayer will not pay; or the wallet itself when the device holds no key (another device, a cleared browser).
 */
export function pickMatchSigner(wallet: ChainSigner | null, matchKey: string | null, ready: boolean, seat: SeatKey | null): ChainSigner | null {
  if (!wallet) return null;
  if (!matchKey) return wallet;
  if (!ready) return null;
  return seat ? { ...seat, fallbackPayer: wallet } : wallet;
}

/**
 * Who plays a Match from this page: the Match's seat key when this device holds it, else the wallet (another device, a cleared
 * browser). Null until that is known, so the wallet is never asked to log in to the rollup in the moment before the key is found.
 * Everything a Match page signs goes through this signer; wallet-only actions (Redeem, Unlock, Protections, profile) use `auth.signer`.
 */
export function useMatchSigner(matchKey: string | null): { signer: ChainSigner | null; seat: SeatKey | null } {
  const { auth } = useAccount();
  const wallet = auth.signer;
  const walletKey = wallet?.publicKey.toBase58() ?? null;
  const [found, setFound] = useState<{ matchKey: string; walletKey: string; seat: SeatKey | null } | null>(null);

  useEffect(() => {
    if (!matchKey || !walletKey || !wallet) return;
    countingFor(matchKey);
    let live = true;
    void seatKeys()
      .find(matchKey, wallet.publicKey)
      .catch(() => null)
      .then((seat) => live && setFound({ matchKey, walletKey, seat }));
    return () => {
      live = false;
    };
    // the wallet object changes with every render of the provider; its address is what the key belongs to
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchKey, walletKey]);

  const ready = !!matchKey && !!walletKey && found?.matchKey === matchKey && found.walletKey === walletKey;
  const seat = ready ? found.seat : null;
  // the seat key plays; the wallet stays behind it for the base-layer steps the relayer will not pay
  const signer = useMemo(
    () => pickMatchSigner(wallet, matchKey, ready, seat),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [walletKey, matchKey, ready, seat],
  );
  return { signer, seat };
}
