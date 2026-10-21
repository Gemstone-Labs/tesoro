import type { ChainSigner } from "@/games/block-puzzle/chain";
import { unlockNative } from "@/lib/chain/native-flow";
import type { VaultSnapshot } from "./vault";

/** Withdraws a deposit that is ready: its SOL goes back to the wallet. */
export async function withdrawDeposit(signer: ChainSigner, snapshot: VaultSnapshot, id: string): Promise<string> {
  const info = snapshot.positions.find((p) => p.address.toBase58() === id)?.native;
  if (!info) throw new Error("That deposit isn't on your Account any more. Refresh and try again.");
  return unlockNative(signer, info);
}
