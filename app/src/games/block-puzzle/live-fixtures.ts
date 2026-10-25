import { PublicKey } from "@solana/web3.js";
import { REASON, SLOTS_PER_SEC, TABLE_PHASE, type Assignment, type OwnBoard, type Table } from "./live-chain";

/** Tables, Assignments and Boards for tests and stories: made up, nothing here is read from a chain. */
export const fixtureKey = (n: number) => PublicKey.findProgramAddressSync([Buffer.from(`burst-${n}`)], PublicKey.default)[0];
/** The slot the fixture table was assigned at; tests and stories measure from it. */
export const ASSIGNED = 1_000_000;

export function blankTable(over: Partial<Table> = {}): Table {
  return {
    address: fixtureKey(0),
    generation: 1,
    index: 0,
    epoch: 4,
    phase: TABLE_PHASE.idle,
    seatsCreated: true,
    seatsOpen: false,
    dirty: false,
    tesoroMatch: fixtureKey(1),
    slot: 0,
    startDeadline: 0,
    players: [fixtureKey(2), fixtureKey(3)],
    checkedIn: [false, false],
    assignedSlot: ASSIGNED,
    assignedTs: 0,
    seedingSlot: 0,
    reqNonce: 0,
    reqPending: false,
    reqSlot: 0,
    reqCount: 0,
    seedReady: false,
    readySlot: 0,
    startSlot: 0,
    shownScore: [0, 0],
    shownMoves: [0, 0],
    overAt: 0,
    reason: REASON.none,
    outcome: 0,
    finalScores: [0, 0],
    finalMoves: [0, 0],
    ring: [],
    logs: [],
    ...over,
  };
}

export const fixtureAssignment = (over: Partial<Assignment> = {}): Assignment => ({
  address: fixtureKey(9),
  tesoroMatch: fixtureKey(1),
  generation: 1,
  index: 0,
  epoch: 4,
  players: [fixtureKey(2), fixtureKey(3)],
  startDeadline: 0,
  payer: fixtureKey(4),
  ...over,
});

export const fixtureBoard = (over: Partial<OwnBoard> = {}): OwnBoard => ({
  seat: 0,
  player: fixtureKey(2),
  tesoroMatch: fixtureKey(1),
  epoch: 4,
  began: false,
  seed: 0n,
  occ: 0n,
  gems: 0n,
  score: 0,
  moves: 0,
  used: 0,
  over: false,
  log: new Uint8Array(0),
  offsets: new Uint8Array(0),
  ...over,
});

export const SECS = SLOTS_PER_SEC;
