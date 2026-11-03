/** LayerZero message types, a mirror of the `MSG_*` constants in bridge/programs/tesoro_bridge/src/msg_codec.rs. `msg-types.test.ts` fails when they differ. */
export const MSG = {
  POSITION_LOCKED: 1,
  YIELD_ACCRUED: 2,
  UNLOCK: 10,
  PAY_YIELD: 11,
  PAY_INSTANT: 12,
  CASH_IN_BATCH: 6,
  PAY_PRIZE: 13,
  BATCH_RESULT: 8,
  PAY_PRIZE_RESULT: 9,
} as const;
