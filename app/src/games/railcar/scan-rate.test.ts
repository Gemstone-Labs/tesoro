import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CarView, SeatView } from "../../lib/chain/many-seat";
import type { TableView } from "./chain";

const key = () => Keypair.generate().publicKey;
const ME = key();
const riding = { address: key(), opener: key(), n: 0n, stage: "departed", seated: 5, pages: 1 } as unknown as CarView;
const table = { carNo: 9n, phase: "riding", index: 0, tesoroMatch: riding.address, nextCar: 9n } as unknown as TableView;

vi.mock("@/lib/chain/many-seat-plan", () => ({
  loadCar: async () => ({ car: riding, seats: [{ index: 0, seated: true, player: ME } as unknown as SeatView], pages: [] }),
}));
vi.mock("./chain", async (orig) => ({
  ...(await orig<typeof import("./chain")>()),
  decodeConfig: () => ({ operator: PublicKey.default, tables: 4, nextCar: 10n, boardingMatch: PublicKey.default }),
  decodeCarAccount: () => ({ table: 0, tesoroMatch: riding.address }),
  decodeTable: () => table,
}));
// readSnapshot touches none of the wallet, signing, sponsor or Entry code useRailcar imports; stubbing them keeps the import of
// the hook cheap (importing the hook cost ~1.5 s inside the first test, which timed out on a loaded machine; the heaviest were the block-puzzle chain client, boarding and the Tell sounds).
vi.mock("@/games/block-puzzle/chain", () => ({ accountOfSigner: () => null, keypairSigner: () => ({}) }));
vi.mock("./boarding", () => ({ backerSeatedIn: () => false, boardingEntry: () => ({}) }));
vi.mock("./tells", () => ({ playTells: () => undefined }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({}) }));
vi.mock("@/lib/chain/client", () => ({ getChain: () => ({}) }));
vi.mock("@/lib/chain/entry", () => ({}));
vi.mock("@/lib/chain/backing", () => ({ BackingError: class extends Error {}, backingProblem: () => null, fetchOffer: async () => null }));
vi.mock("@/lib/chain/ticket", () => ({}));
vi.mock("@/lib/chain/sponsor-client", () => ({}));
vi.mock("@/lib/seat/seat-key", () => ({ seatKeys: {} }));
vi.mock("@/lib/seat/signature-counter", () => ({ countingFor: () => ({}) }));
vi.mock("@/lib/chain/settle-plan", () => ({ connReader: () => ({}), fits: () => true, simulatedUnits: async () => 0 }));
vi.mock("./flow", async (orig) => ({ ...(await orig<typeof import("./flow")>()), watchedRide: () => table }));

/** The rollup requests one read of a page's snapshot makes. */
function rig() {
  const rollup = { getAccountInfo: vi.fn(async () => ({ data: Buffer.alloc(8) })), getMultipleAccountsInfo: vi.fn(async () => [{ data: Buffer.alloc(8) }]) };
  const read = { many: async (keys: PublicKey[]) => keys.map(() => ({ data: Buffer.alloc(8) })) } as never;
  return { rollup, read, tee: async () => rollup as never, calls: () => rollup.getAccountInfo.mock.calls.length + rollup.getMultipleAccountsInfo.mock.calls.length };
}
const mine = { carNo: "9", table: 0, match: riding.address.toBase58(), matchKey: "x-9" };

describe("readSnapshot rollup requests while a ride runs", () => {
  // The hook's module graph loads once, here, with its own generous timeout: a loaded machine slows the import, not the checks.
  let readSnapshot: typeof import("./useRailcar").readSnapshot;
  beforeAll(async () => {
    ({ readSnapshot } = await import("./useRailcar"));
  }, 60_000);

  it("a Player's page asks the rollup once per read without a feed (before), and not at all with one", async () => {
    const a = rig();
    await readSnapshot(a.read, a.tee, ME, mine, null);
    expect(a.calls()).toBe(1);
    const b = rig();
    const s = await readSnapshot(b.read, b.tee, ME, mine, null, { fed: () => table });
    expect(b.calls()).toBe(0);
    expect(s.rollup).toBe(table);
  });

  it("a watcher's page reads every Table only on a scan; between scans it follows the ride it found through the feed", async () => {
    const a = rig();
    const first = await readSnapshot(a.read, a.tee, null, null, null, { scan: true, fed: () => table });
    expect(a.rollup.getMultipleAccountsInfo).toHaveBeenCalledTimes(1);
    expect(first.watching).toBe(true);
    const b = rig();
    const next = await readSnapshot(b.read, b.tee, null, null, null, { scan: false, watching: { carNo: 9n, table: 0, match: riding.address }, fed: () => table });
    expect(b.calls()).toBe(0);
    expect(next.watching).toBe(true);
    expect(next.rollup).toBe(table);
  });
});
