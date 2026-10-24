import { readFileSync } from "node:fs";
import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import idl from "@/lib/chain/idl/holdem.json";
import { decodeAssignment, decodeTable } from "./chain";
import { useHoldemMatch } from "./useHoldemMatch";

const mocks = vi.hoisted(() => ({ effects: [] as (() => void | (() => void))[], fetchMatch: vi.fn(), getHoldem: vi.fn() }));
// Drive the real hook's first polling step without a browser or a network connection.
vi.mock("react", () => ({
  useCallback: (fn: unknown) => fn,
  useMemo: (fn: () => unknown) => fn(),
  useRef: (current: unknown) => ({ current }),
  useState: (value: unknown) => [value, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => mocks.effects.push(effect),
}));
vi.mock("@/lib/chain/client", () => ({ getHoldem: mocks.getHoldem }));
vi.mock("@/lib/chain/read", () => ({ fetchMatch: mocks.fetchMatch }));

const fixture = JSON.parse(readFileSync(new URL("../../../../keeper/fixtures/holdem-layouts.json", import.meta.url), "utf8"));
const coder = new Program(idl as unknown as Idl, new AnchorProvider(new Connection("http://127.0.0.1:1"), {} as never, {})).coder.accounts;
const key = new PublicKey(new Uint8Array(32).fill(1));
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  mocks.effects.length = 0;
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("Hold'em Match startup", () => {
  it("begins an assigned idle table before it has a Match key", async () => {
    vi.useFakeTimers();
    const table = decodeTable(key, coder.decode("table", Buffer.from(fixture.idle_table, "hex")));
    const assignment = { ...decodeAssignment(key, coder.decode("assignment", Buffer.from(fixture.assignment, "hex"))), generation: table.generation, index: table.index, epoch: table.epoch, startDeadline: Date.now() / 1000 + 60 };
    const beginMatch = vi.fn().mockResolvedValue("started");
    const readTableOnBase = vi.fn().mockResolvedValue(table);
    mocks.getHoldem.mockReturnValue({ readAssignment: vi.fn().mockResolvedValue(assignment), readTable: vi.fn().mockResolvedValue(table), readTableOnBase, beginMatch });
    mocks.fetchMatch.mockResolvedValue({ status: "active", seat: 1, deadline: Date.now() / 1000 + 600 });
    useHoldemMatch(`${key.toBase58()}-0`, { publicKey: key } as never);
    for (const effect of mocks.effects) {
      const cleanup = effect();
      if (cleanup) cleanups.push(cleanup);
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(beginMatch).toHaveBeenCalledWith(expect.objectContaining({ publicKey: key }), assignment);
    expect(readTableOnBase).not.toHaveBeenCalled();
  });
});
