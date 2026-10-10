// Storybook: LayerZero Scan answers from the story's opening step instead of the network.
import type { ScanStatus } from "../../../../../src/lib/chain/eth-track";
import { screenData } from "../../../../../stories/screens/support/screen";

export * from "../../../../../src/lib/chain/eth-track";

export async function fetchScanStatus(): Promise<ScanStatus | null> {
  const step = screenData().eth?.opening;
  return step === "sent" ? { name: "INFLIGHT", destinationTx: null } : step === "delivered" ? { name: "DELIVERED", destinationTx: null } : null;
}
