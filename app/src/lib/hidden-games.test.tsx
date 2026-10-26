import { renderToStaticMarkup } from "react-dom/server";
import { PublicKey } from "@solana/web3.js";
import type { GameId } from "@/lib/mock/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { GAME_IDS } from "@/lib/chain/games";
import { refuseHiddenGames } from "@/server/sponsor/service";
import { coreIx, key, openMatchIx } from "@/server/sponsor/fixtures";

vi.mock("@/components/lobby/useQueue", () => ({ useQueue: () => null }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ auth: { status: "signed-out" }, snapshot: null, openMatches: [], error: null }) }));

vi.mock("@/lib/friends/FriendsProvider", () => ({ useFriends: () => ({ status: "ready", view: { challenges: [] } }) }));
vi.mock("@/lib/chain/useRecentSettled", () => ({ useRecentSettled: () => ({ matches: [], loading: false, error: null }) }));

/** Loads a module fresh with NEXT_PUBLIC_HIDDEN_GAMES set (or unset), as a build would see it. */
async function withSwitch<T>(value: string | undefined, load: () => Promise<T>): Promise<T> {
  vi.resetModules();
  if (value === undefined) vi.stubEnv("NEXT_PUBLIC_HIDDEN_GAMES", "");
  else vi.stubEnv("NEXT_PUBLIC_HIDDEN_GAMES", value);
  return load();
}

afterEach(() => vi.unstubAllEnvs());

/**
 * Tests that load pages or the chain reader fresh after `vi.resetModules()` re-evaluate a large module graph (the
 * Play home, the Docs pages, the chain reader and their chain clients). That takes seconds alone and several times
 * longer when the suite's workers compete for the CPU, so they get a budget sized for the loaded case instead of
 * vitest's 5 s. The sponsor checks below take the hidden set as an argument and import their graph once at the top,
 * so they do not pay this cost at all.
 */
const COLD_GRAPH_MS = 30_000;
const hidden = new Set<GameId>(["vanguard"]);

describe("NEXT_PUBLIC_HIDDEN_GAMES", () => {
  it("parses names, ignores unknown ones, hides nothing when empty", async () => {
    const g = await withSwitch(undefined, () => import("./games"));
    expect(g.HIDDEN_GAMES.size).toBe(0);
    expect(g.GAME_LIST).toContain("vanguard");
    expect(g.parseHiddenGames(" vanguard , nope ,holdem")).toEqual(new Set(["vanguard", "holdem"]));
  });

  it("removes the Game from the list, the id guard (404, fallbacks), the catalogue and the Lobby order", { timeout: COLD_GRAPH_MS }, async () => {
    const g = await withSwitch("vanguard", () => import("./games"));
    expect(g.GAME_LIST).toEqual(["block-puzzle", "holdem", "trading-duel"]);
    expect(g.isGameId("vanguard")).toBe(false);
    expect(g.isGameId("holdem")).toBe(true);
    const params = await import("./game-params");
    expect(params.gameFromParam("vanguard")).toBe("block-puzzle");
    const c = await import("./catalogue");
    expect(c.LOBBY_ORDER).toEqual(["holdem", "trading-duel", "block-puzzle"]);
    expect(c.CATALOGUE.some((e) => e.game === "vanguard")).toBe(false);
    expect(c.CATALOGUE.some((e) => e.name === "Word Duel")).toBe(true);
  });

  it("keeps the Game when the switch is unset", async () => {
    const c = await withSwitch(undefined, () => import("./catalogue"));
    expect(c.LOBBY_ORDER[0]).toBe("vanguard");
  });

  it("leaves Vanguard out of the rendered Play home, the landing Games and the Docs lists", { timeout: COLD_GRAPH_MS }, async () => {
    await withSwitch("vanguard", async () => undefined);
    const { PlayHome } = await import("@/app/(app)/play/PlayHome");
    const home = renderToStaticMarkup(<PlayHome />);
    expect(home).not.toMatch(/vanguard/i);
    expect(home).toContain('href="/play/holdem"');
    const { GameCards } = await import("@/components/docs/visual");
    expect(renderToStaticMarkup(<GameCards />)).not.toMatch(/vanguard/i);
    const { StartCards } = await import("@/components/docs/StartCards");
    expect(renderToStaticMarkup(<StartCards />)).not.toMatch(/vanguard/i);
    const { CHANGES } = await import("@/components/docs/changelog");
    expect(CHANGES.some((c) => /vanguard/i.test(`${c.title} ${c.body}`))).toBe(false);
    const Matches = (await import("@/app/(docs)/docs/matches/page")).default;
    expect(renderToStaticMarkup(<Matches />)).not.toMatch(/vanguard/i);
    const Fairness = (await import("@/app/(docs)/docs/fairness/page")).default;
    expect(renderToStaticMarkup(<Fairness />)).not.toMatch(/vanguard/i);
    const Rollups = (await import("@/app/(docs)/docs/developers/rollups/page")).default;
    expect(renderToStaticMarkup(<Rollups />)).not.toMatch(/vanguard/i);
  });

  it("shows Vanguard in the same Docs page when the switch is unset", { timeout: COLD_GRAPH_MS }, async () => {
    await withSwitch(undefined, async () => undefined);
    const Matches = (await import("@/app/(docs)/docs/matches/page")).default;
    expect(renderToStaticMarkup(<Matches />)).toMatch(/vanguard/i);
  });

  it("refuses a sponsored instruction that calls or names a hidden Game's program, and lets others through", () => {
    const ix = (programId: PublicKey, extra: PublicKey[] = []) => ({ programId, keys: extra.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })), data: new Uint8Array() });
    expect(() => refuseHiddenGames([ix(GAME_IDS.vanguard)], hidden)).toThrow(/not available/);
    expect(() => refuseHiddenGames([ix(PublicKey.default, [GAME_IDS.vanguard])], hidden)).toThrow(/not available/);
    expect(() => refuseHiddenGames([ix(GAME_IDS.holdem)], hidden)).not.toThrow();
    expect(() => refuseHiddenGames([ix(GAME_IDS.vanguard)], new Set())).not.toThrow();
  });

  it("refuses a core instruction that carries the hidden Game only in its data", async () => {
    // open_match with every account swapped for a stranger: only the game argument names Vanguard.
    const open = await openMatchIx(key(), key(), GAME_IDS.vanguard, { gameProgram: key(), gameRecord: key() });
    expect(open.keys.some((k) => k.pubkey.equals(GAME_IDS.vanguard))).toBe(false);
    expect(() => refuseHiddenGames([open], hidden)).toThrow(/not available/);
    const req = await coreIx("create_request", [new BN(1), GAME_IDS.vanguard, new BN(500)], { playerAuthority: key(), gameRecord: key() });
    expect(() => refuseHiddenGames([req], hidden)).toThrow(/not available/);
    const fine = await openMatchIx(key(), key(), GAME_IDS.holdem, { gameProgram: key(), gameRecord: key() });
    expect(() => refuseHiddenGames([fine], hidden)).not.toThrow();
  });

  it("rejects hidden chain Matches without removing keeper program recognition", { timeout: COLD_GRAPH_MS }, async () => {
    await withSwitch("vanguard", async () => undefined);
    const { gameOf, requireGame } = await import("./chain/read");
    const { GAME_IDS, gameOfProgram } = await import("./chain/games");
    expect(gameOf(GAME_IDS.vanguard)).toBeNull();
    expect(() => requireGame(GAME_IDS.vanguard)).toThrow(/Unknown game/);
    expect(gameOf(GAME_IDS.holdem)).toBe("holdem");
    expect(gameOfProgram(GAME_IDS.vanguard)).toBe("vanguard");
    await withSwitch(undefined, async () => undefined);
    expect((await import("./chain/read")).gameOf(GAME_IDS.vanguard)).toBe("vanguard");
  });

  it("takes hidden Games out of history rows, totals and recent wins", async () => {
    const { visibleAccountHistory, visibleRecentWins } = await import("@/server/history/reads");
    const row = (id: string, game: string) => ({ id, game });
    const all = [row("a", "holdem"), row("b", "vanguard"), row("c", "block-puzzle"), row("d", "vanguard"), row("e", "trading-duel")];
    const rpc = (async (fn: string, a: { p_page?: number; p_size?: number; p_game?: string | null }) => {
      if (fn === "recent_wins") return all;
      const size = a.p_size ?? 10;
      const pageRows = all.filter((r) => !a.p_game || r.game === a.p_game);
      const page = a.p_page ?? 1;
      return { rows: pageRows.slice((page - 1) * size, page * size), page, pages: Math.max(1, Math.ceil(pageRows.length / size)), total: pageRows.length };
    }) as never;
    const hidden = new Set(["vanguard"]);
    const h = await visibleAccountHistory(rpc, "acct", 1, 2, null, hidden);
    expect(h.rows.map((r) => r.id)).toEqual(["a", "c"]);
    expect(h).toMatchObject({ total: 3, pages: 2 });
    expect((await visibleAccountHistory(rpc, "acct", 2, 2, null, hidden)).rows.map((r) => r.id)).toEqual(["e"]);
    expect((await visibleAccountHistory(rpc, "acct", 1, 10, null, new Set())).total).toBe(5);
    expect((await visibleRecentWins(rpc, { limit: 10 }, hidden)).map((w) => w.id)).toEqual(["a", "c", "e"]);
  });
});
