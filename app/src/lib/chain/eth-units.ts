/**
 * EVM vaults speak wei (18 decimals); tesoro_core holds every amount of an ETH or HYPE Position in
 * 9-decimal units (1e-9 token), so no amount can pass u64. The bridge rounds vault figures DOWN to
 * whole units and asks the vault back in exact multiples. Raw wei fields (BridgePosition, VaultTreasury,
 * the vault itself) and core units must never be compared directly: convert with these.
 */
export const ETH_CORE_DECIMALS = 9;
export const CORE_UNIT_WEI = 10n ** 9n;
/** The vault refuses a Lock below one core unit (it would open as zero) or above 2^64 core units. */
export const MIN_PRINCIPAL_WEI = CORE_UNIT_WEI;
export const MAX_PRINCIPAL_WEI = ((1n << 64n) - 1n) * CORE_UNIT_WEI;

/** Vault wei as core units, rounded down: never more than the vault reported. */
export const weiToCoreUnits = (wei: bigint): bigint => wei / CORE_UNIT_WEI;
/** Core units as vault wei, exact: what the vault is asked to pay. */
export const coreUnitsToWei = (units: bigint): bigint => units * CORE_UNIT_WEI;
