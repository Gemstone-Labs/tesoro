import { PublicKey, type AccountMeta } from "@solana/web3.js";
import type { Reader } from "./supply.ts";
import { meta } from "./core-ix.ts";
import { pda } from "./kit.ts";

export const SIM_LST_ID = new PublicKey("WgcM5GessXmBx91ggdMrgFEVaitNQBJZ3KTmz1VqD4F");
export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const yieldConfig = PublicKey.findProgramAddressSync([Buffer.from("yield_config")], SIM_LST_ID)[0];

/** The associated token account of `owner` for `mint`. */
export const ata = (owner: PublicKey, mint: PublicKey) => PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];

export interface Custody {
  kind: "native" | "stake";
  address: PublicKey;
  vault: PublicKey;
  /** The sim_lst pool (native) or the stake pool (stake). */
  pool: PublicKey;
  mint: PublicKey;
}

/**
 * The accounts of an instruction that pays out of a custody (`KindCtx::load` with a payee, programs/tesoro_core/src/
 * instructions/economy.rs): native `[custody, vault, pool, destination, mint, yield_config, yield_authority, sim_lst,
 * token program]`, stake `[custody, stake pool, vault, destination, token program]`. `destination` is the payee's token
 * account for the custody's mint (a wallet's associated account, or the Treasury's vault).
 */
export function payingAccounts(c: Custody, destination: PublicKey): AccountMeta[] {
  if (c.kind === "native") {
    return [meta(c.address), meta(c.vault), meta(c.pool), meta(destination), meta(c.mint), meta(yieldConfig, false), meta(pda("yield"), false), meta(SIM_LST_ID, false), meta(TOKEN_PROGRAM_ID, false)];
  }
  return [meta(c.address), meta(c.pool, false), meta(c.vault), meta(destination), meta(TOKEN_PROGRAM_ID, false)];
}

/** The accounts of an instruction that only reads the custody's rate (`PayTo::Nobody`): `[custody, pool]`. */
export const ratingAccounts = (c: Custody): AccountMeta[] => [meta(c.address, false), meta(c.pool, false)];

/** What kind a decoded `PositionState` is: a native (simSOL) one, a staking-token one, or reported (bridged, or reported by the oracle). */
export function kindOfPosition(position: any, simSolMint: PublicKey): "native" | "stake" | "reported" {
  if (Object.keys(position.inner.sourceChain)[0] !== "solana") return "reported";
  const asset = new PublicKey(Uint8Array.from(position.inner.sourceAsset));
  if (asset.equals(simSolMint)) return "native";
  return Number(position.inner.stakeRateOpen?.toString() ?? 0) !== 0 ? "stake" : "reported";
}

/** The custody a Solana Position pays from (null for a reported Position, or when the custody is not there). */
export async function custodyOf(core: { coder: any }, read: Reader, position: any, simSolMint: PublicKey): Promise<Custody | null> {
  const kind = kindOfPosition(position, simSolMint);
  if (kind === "reported") return null;
  const mint = new PublicKey(Uint8Array.from(position.inner.sourceAsset));
  const address = kind === "native" ? pda("native") : pda("stake_custody", mint.toBuffer());
  const [info] = await read.many([address]);
  if (!info) return null;
  const c: any = core.coder.accounts.decode(kind === "native" ? "nativeCustody" : "stakeCustody", info.data);
  return { kind, address, vault: new PublicKey(c.vault), pool: new PublicKey(c.pool), mint: new PublicKey(c.mint) };
}
