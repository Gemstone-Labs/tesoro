// Storybook: a Match can start its run without a rollup, and MatchRoute learns the Game from the story's Match; every other read still goes through the (blocked) real client.
import * as real from "../../../../../src/lib/chain/client";
import { BLOCK_PUZZLE_PROGRAM_ID } from "../../../../../src/games/block-puzzle/chain";
import { HOLDEM_PROGRAM_ID } from "../../../../../src/games/holdem/chain";
import { TRADING_DUEL_PROGRAM_ID } from "../../../../../src/games/trading-duel/chain";
import { VANGUARD_PROGRAM_ID } from "../../../../../src/games/vanguard/chain";
import { spectated } from "../../../../../stories/components/support/spectated";
import { flowFrame, untilFrame } from "../../../../../stories/screens/support/flow-store";
import { screenData } from "../../../../../stories/screens/support/screen";

const PROGRAMS = { "block-puzzle": BLOCK_PUZZLE_PROGRAM_ID, holdem: HOLDEM_PROGRAM_ID, "trading-duel": TRADING_DUEL_PROGRAM_ID, vanguard: VANGUARD_PROGRAM_ID };

/** The MatchState read MatchRoute makes: only the Game's program id matters. In a flow story it answers at the step that says so. */
async function matchState() {
  if (flowFrame()) await untilFrame((f) => !!f.routed);
  const m = spectated();
  return m ? { inner: { game: Array.from(PROGRAMS[m.game].toBytes()) } } : null;
}

export const { getHoldem, getVanguard } = real;

let duel: ReturnType<typeof real.getTradingDuel> | null = null;

/** Spectators of a finished Duel read both Books from the story. */
export function getTradingDuel() {
  duel ??= Object.assign(Object.create(real.getTradingDuel()), {
    readDuelOnBase: async () => screenData().duel?.duel ?? null,
  });
  return duel!;
}

let wrapped: ReturnType<typeof real.getChain> | null = null;

export function getChain() {
  if (wrapped) return wrapped;
  const chain = real.getChain();
  const core = chain.core;
  const matchStateClient = Object.assign(Object.create(core.account.matchState), { fetchNullable: matchState });
  wrapped = Object.assign(Object.create(chain), {
    core: Object.assign(Object.create(core), { account: Object.assign(Object.create(core.account), { matchState: matchStateClient }) }),
    beginRun: async () => ({ sig: "demo-begin", seed: 0x5eed1234n }),
    finish: async () => "demo-finish",
  });
  return wrapped!;
}
