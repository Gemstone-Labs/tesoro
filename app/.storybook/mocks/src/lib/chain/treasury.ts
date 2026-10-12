// Storybook: the bridge's mirror of each EVM vault's treasury is a fixed example for the story; no RPC.
import { netOfVault } from "../../../../../src/lib/chain/eth";
import type { VaultTreasuryView } from "../../../../../src/lib/chain/fees";
import { screenData } from "../../../../../stories/screens/support/screen";

export * from "../../../../../src/lib/chain/treasury";

const E = 10n ** 18n;

export async function fetchVaultTreasuries(_c: unknown, vaults: { vault: string; eid: number }[]): Promise<Map<string, VaultTreasuryView>> {
  const kind = screenData().vaultTreasury ?? "ready";
  const out = new Map<string, VaultTreasuryView>();
  if (kind === "none") return out;
  for (const { vault } of vaults) {
    const reportedIn = (netOfVault(vault).native === "ETH" ? 3n : 40n) * E;
    const available = kind === "short" ? E / 1000n : reportedIn;
    out.set(vault.toLowerCase(), { reportedIn, instantRecorded: reportedIn - available, available });
  }
  return out;
}
