/**
 * Byte length of a current `PositionState` (tesoro_core `PositionState::SPACE`, 243 since ticket 55 appended
 * `stake_rate_high`). Positions written before ticket 55 are 235 bytes until the admin migrates them
 * (`migrate_position`); older ones are shorter and cannot be decoded, so every list of Positions keeps only these two
 * lengths and one stray old account never breaks a whole read.
 */
export const POSITION_SPACE = 243;
export const LEGACY_POSITION_SPACE = 235;

export const isCurrentPosition = (data: { length: number }): boolean =>
  data.length === POSITION_SPACE || data.length === LEGACY_POSITION_SPACE;

/** Byte of `open_advance`'s Borsh tag: 1 byte for None, 5 for Some, so every later field sits 4 bytes apart between the two. */
const OPEN_ADVANCE_TAG_AT = 122;

/** Where a Position's serialised fields end: `stake_rate_high` (u64) is the last of them in the current layout. */
const serialisedEnd = (d: Uint8Array, space: number): number => (d[OPEN_ADVANCE_TAG_AT] === 1 ? space : space - 4);

/**
 * The bytes the current IDL coder decodes. A 235-byte Position is cut at the end of its own fields (a Some -> None rewrite
 * leaves stale bytes after a shorter `None`) and given a zero `stake_rate_high`; a 243-byte one is read as it is.
 */
export function positionBytes(data: Uint8Array): Buffer {
  const d = Buffer.from(data);
  if (d.length !== LEGACY_POSITION_SPACE) return d;
  const end = serialisedEnd(d, LEGACY_POSITION_SPACE);
  const out = Buffer.alloc(end + 8);
  d.copy(out, 0, 0, end);
  return out;
}

/** Decodes a Position of either layout with `decode` (the IDL coder's `positionState`). */
export const decodePosition = <T>(decode: (data: Buffer) => T, data: Uint8Array): T => decode(positionBytes(data));

/** `stake_rate_high` read from the raw bytes: the highest Staking Rate the Position's yield was priced at (1e12); 0 before migration. */
export function stakeRateHighOf(data: Uint8Array): bigint {
  if (data.length < POSITION_SPACE) return 0n;
  const end = serialisedEnd(data, POSITION_SPACE);
  return Buffer.from(data).readBigUInt64LE(end - 8);
}
