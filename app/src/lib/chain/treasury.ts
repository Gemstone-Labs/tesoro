import "./polyfill";
import { PublicKey, type Connection } from "@solana/web3.js";
import { BRIDGE_ID, vaultTreasuryPda } from "./eth";
import { TESORO_CORE_ID } from "./native";
import { parseTreasury, parseVaultShares, parseVaultTreasury, type TreasuryRates, type VaultTreasuryView } from "./fees";

/** Fetching Tesoro's Treasury and the bridge's mirror of each EVM vault's treasury (decoders and math: fees.ts). */

/** The bridge's mirror for each vault; a vault that has none (old vault, not wired) is absent from the map. */
export async function fetchVaultTreasuries(c: Connection, vaults: { vault: string; eid: number }[]): Promise<Map<string, VaultTreasuryView>> {
  const out = new Map<string, VaultTreasuryView>();
  if (vaults.length === 0) return out;
  const infos = await c.getMultipleAccountsInfo(vaults.map((v) => vaultTreasuryPda(v.eid, v.vault)), "confirmed");
  infos.forEach((info, i) => {
    const view = info && info.owner.equals(BRIDGE_ID) ? parseVaultTreasury(info.data) : null;
    if (view) out.set(vaults[i].vault.toLowerCase(), view);
  });
  return out;
}

/** Reads the Treasury on its own (the app gets it with the market; the keeper and scripts use this). Null before `init_treasury`. */
export async function fetchTreasury(c: Connection, treasury: PublicKey, vault: PublicKey): Promise<{ rates: TreasuryRates; shares: bigint } | null> {
  const [t, v] = await c.getMultipleAccountsInfo([treasury, vault], "confirmed");
  const rates = t && t.owner.equals(TESORO_CORE_ID) ? parseTreasury(t.data) : null;
  return rates ? { rates, shares: (v && parseVaultShares(v.data)) ?? 0n } : null;
}
