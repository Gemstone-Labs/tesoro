/**
 * Throwaway interaction fixtures. Synthetic starting boards are never submitted
 * to a Match. Placement, scoring and subsequent seeded pieces use engine.ts
 * unchanged; combo presentation belongs to the prototype UI.
 */
import {
  apply, EngineFailure, handBase, newState, pieceAt, pieceCells,
  type EngineError, type MoveResult, type Piece, type State,
} from "../engine";

export const EMPTY_COLOR = 255;
export const FIXTURE_SEED = 22n;
export type FixtureId = "placement" | "single" | "consecutive" | "bridge";
export interface GuidedMove { slot: number; x: number; y: number; label: string }

export const FIXTURES: readonly {
  id: FixtureId; label: string; description: string; sequence: readonly GuidedMove[];
}[] = [
  {
    id: "placement", label: "Pickup and drop",
    description: "Place anywhere empty. Try dropping over the top-left blocks or outside the board; the piece must return without changing the score.",
    sequence: [
      { slot: 0, x: 2, y: 3, label: "Place the first four-block bar in the middle" },
      { slot: 1, x: 2, y: 5, label: "Place another bar below it" },
      { slot: 2, x: 3, y: 7, label: "Place the two-block bar along the bottom" },
    ],
  },
  {
    id: "single", label: "One clear",
    description: "Fill the four empty cells in row four. Pick up the next piece while the clear and score receipt are still running.",
    sequence: [
      { slot: 0, x: 4, y: 3, label: "Complete row four with the first bar" },
      { slot: 1, x: 2, y: 5, label: "Place the next bar while the reward plays" },
      { slot: 2, x: 3, y: 7, label: "Place the two-block bar along the bottom" },
    ],
  },
  {
    id: "consecutive", label: "Consecutive clears",
    description: "Complete row four, then row six. The second clear can start before the first score receipt finishes.",
    sequence: [
      { slot: 0, x: 4, y: 3, label: "Complete row four with the first bar" },
      { slot: 1, x: 4, y: 5, label: "Complete row six with the second bar" },
      { slot: 2, x: 3, y: 7, label: "Place the two-block bar along the bottom" },
    ],
  },
  {
    id: "bridge", label: "Clear, place, clear",
    description: "Clear row four, make an ordinary placement, then clear row six. Compare reward continuity separately from the unchanged point values.",
    sequence: [
      { slot: 0, x: 4, y: 3, label: "Complete row four with the first bar" },
      { slot: 1, x: 2, y: 0, label: "Make an ordinary placement at the top" },
      { slot: 2, x: 6, y: 5, label: "Complete row six with the two-block bar" },
    ],
  },
];

export interface GuidedStep extends GuidedMove { id: string; title: string; reason: string }
export function guidedSteps(fixture: FixtureId): readonly GuidedStep[] {
  const definition = FIXTURES.find((item) => item.id === fixture)!;
  return definition.sequence.map((move, i) => ({
    ...move,
    id: `${fixture}-${i + 1}`,
    title: move.label,
    reason: fixture === "placement"
      ? "Compare pickup, travel, preview and release on the same target."
      : fixture === "bridge" && i === 1
        ? "This earns four placement points; compare whether the reward streak survives it."
        : i === 0 || fixture === "consecutive" && i === 1 || fixture === "bridge" && i === 2
          ? "Watch the line disappear, the bonus remain readable and the score receive its points."
          : "Try starting this move before the preceding reward animation has finished.",
  }));
}

export interface FixtureState {
  fixture: FixtureId;
  st: State;
  colors: readonly number[];
  lines: number;
  gemsCleared: number;
}
export interface ClearedCell { i: number; color: number; gem: boolean }
export type PlacementOutcome =
  | { accepted: false; state: FixtureState; error: EngineError }
  | {
    accepted: true; state: FixtureState; result: MoveResult;
    piece: Piece; index: number; placed: bigint; cleared: readonly ClearedCell[];
  };

export function initialFixture(fixture: FixtureId): FixtureState {
  const st = newState(FIXTURE_SEED);
  const colors = Array<number>(64).fill(EMPTY_COLOR);
  const fill = (x: number, y: number, color: number) => {
    const i = y * 8 + x;
    st.occ |= 1n << BigInt(i);
    colors[i] = color;
  };
  if (fixture === "placement") {
    fill(0, 0, 0);
    fill(1, 0, 0);
  } else {
    for (let x = 0; x < 4; x++) fill(x, 3, x % 4);
    if (fixture === "consecutive" || fixture === "bridge") {
      const filled = fixture === "bridge" ? 6 : 4;
      for (let x = 0; x < filled; x++) fill(x, 5, (x + 2) % 4);
    }
  }
  return { fixture, st, colors, lines: 0, gemsCleared: 0 };
}

export function hand(state: FixtureState) {
  const base = handBase(state.st);
  return [0, 1, 2].map((slot) => ({
    slot, index: base + slot,
    piece: pieceAt(state.st.seed, base + slot),
    used: ((state.st.used >> slot) & 1) !== 0,
  }));
}

/** Pure attempt: a rejected drop returns the identical state and spends nothing. */
export function attemptPlacement(state: FixtureState, slot: number, x: number, y: number): PlacementOutcome {
  if (!Number.isInteger(slot) || slot < 0 || slot > 2) return { accepted: false, state, error: "BadPiece" };
  const index = handBase(state.st) + slot;
  let next;
  try {
    next = apply(state.st, { piece: index, x, y });
  } catch (error) {
    if (error instanceof EngineFailure) return { accepted: false, state, error: error.code };
    throw error;
  }
  const piece = pieceAt(state.st.seed, index);
  const colors = state.colors.slice();
  let placed = 0n;
  let placedGems = 0n;
  for (const cell of pieceCells(piece)) {
    const i = (y + cell.dy) * 8 + x + cell.dx;
    const bit = 1n << BigInt(i);
    placed |= bit;
    if (cell.gem) placedGems |= bit;
    colors[i] = piece.kind % 4;
  }
  const cleared: ClearedCell[] = [];
  for (let i = 0; i < 64; i++) {
    const bit = 1n << BigInt(i);
    if ((next.result.cleared & bit) !== 0n) {
      cleared.push({ i, color: colors[i], gem: ((state.st.gems | placedGems) & bit) !== 0n });
      colors[i] = EMPTY_COLOR;
    }
  }
  return {
    accepted: true, result: next.result, piece, index, placed, cleared,
    state: {
      fixture: state.fixture, st: next.state, colors,
      lines: state.lines + next.result.lines,
      gemsCleared: state.gemsCleared + next.result.gems,
    },
  };
}
