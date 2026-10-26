import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { BRIDGE_AUTHORITY, BRIDGE_ID, bridgePeerPda, bridgePositionPda, bridgeStore, corePositionPda, disc, netOfVault, sourceAuthPda, vaultTreasuryPda } from "@/lib/chain/eth";
import { sourcePda, TESORO_CORE_ID } from "@/lib/chain/native";
import { sourceAccounts } from "@/lib/chain/redeem";

/** The relay and keeper must pass the Source book when core applies a reported yield landing. */
export async function applyYieldInstructions(conn: Parameters<typeof sourceAccounts>[0], payer: PublicKey, vault: string, pid: Buffer, openAdvance: number | null): Promise<TransactionInstruction[]> {
  const net = netOfVault(vault);
  const cp = corePositionPda(pid);
  const source = openAdvance === null ? null : sourcePda(cp, openAdvance);
  const eid = Buffer.alloc(4);
  eid.writeUInt32LE(net.eid);
  const key = (pubkey: PublicKey, isWritable = false) => ({ pubkey, isSigner: false, isWritable });
  const plan = source ? await sourceAccounts(conn, source, [], payer) : { accounts: [], create: [] };
  return [...plan.create, new TransactionInstruction({
    programId: BRIDGE_ID,
    keys: [key(bridgeStore()), key(bridgePeerPda(vault)), key(bridgePositionPda(pid), true), key(vaultTreasuryPda(net.eid, vault), true), key(BRIDGE_AUTHORITY), key(sourceAuthPda(net)), key(cp, true), key(source ?? BRIDGE_ID, source !== null), key(TESORO_CORE_ID), ...plan.accounts.map((k) => key(k, true))],
    data: Buffer.concat([disc("apply_yield"), eid, pid]),
  })];
}
