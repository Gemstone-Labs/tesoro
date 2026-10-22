/**
 * Byte length of a current `PositionState` (tesoro_core `PositionState::SPACE`). Positions opened
 * before the yield-by-math upgrade are shorter and cannot be decoded; until the admin retires them
 * (`retire_position`) every list of Positions keeps only accounts of this length, so one stray old
 * account never breaks a whole read.
 */
export const POSITION_SPACE = 235;

export const isCurrentPosition = (data: { length: number }): boolean => data.length === POSITION_SPACE;
