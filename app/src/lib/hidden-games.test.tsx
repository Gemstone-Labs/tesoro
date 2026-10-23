import { renderToStaticMarkup } from "react-dom/server";
import { PublicKey } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/shell/SearchContext", () => ({ useSearch: () => ({ query: "", setQuery: () => undefined }), matchesQuery: () => true }));
vi.mock("@/components/lobby/useQueue", () => ({ useQueue: () => null }));
vi.mock("@/lib/account", () => ({ useAccount: () => ({ auth: { status: "signed-out" }, snapshot: null }) }));

/** Loads a module fresh with NEXT_PUBLIC_HIDDEN_GAMES set (or unset), as a build would see it. */
async function withSwitch<T>(value: string | undefined, load: () => Promise<T>): Promise<T> {
  vi.resetModules();
  if (value === undefined) vi.stubEnv("NEXT_PUBLIC_HIDDEN_GAMES", "");
  else vi.stubEnv("NEXT_PUBLIC_HIDDEN_GAMES", value);
  return load();
}

afterEach(() => vi.unstubAllEnvs());

describe("NEXT_PUBLIC_HIDDEN_GAMES", () => {
  it("parses names, ignores unknown ones, hides nothing when empty", async () => {
    const g = await withSwitch(undefined, () => import("./games"));
    expect(g.HIDDEN_GAMES.size).toBe(0);
    expect(g.GAME_LIST).toContain("vanguard");
    expect(g.parseHiddenGames(" vanguard , nope ,holdem")).toEqual(new Set(["vanguard", "holdem"]));
  });

  it("removes the Game from the list, the id guard (404, fallbacks), the catalogue and the Lobby order", async () => {
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
    const hero = await import("@/components/lobby/HeroCarousel");
    expect(hero.SLIDES.map((s) => s.game)).toEqual(["holdem", "trading-duel", "block-puzzle"]);
  });

  it("keeps the Game when the switch is unset", async () => {
    const c = await withSwitch(undefined, () => import("./catalogue"));
    expect(c.LOBBY_ORDER[0]).toBe("vanguard");
  });

  it("leaves Vanguard out of the rendered Lobby rail, the landing Games and the Docs lists", async () => {
    await withSwitch("vanguard", async () => undefined);
    const { PlayNowRail } = await import("@/components/lobby/PlayNowRail");
    expect(renderToStaticMarkup(<PlayNowRail />)).not.toMatch(/vanguard/i);
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

  it("shows Vanguard in the same Docs page when the switch is unset", async () => {
    await withSwitch(undefined, async () => undefined);
    const Matches = (await import("@/app/(docs)/docs/matches/page")).default;
    expect(renderToStaticMarkup(<Matches />)).toMatch(/vanguard/i);
  });

  it("refuses a sponsored instruction that calls or names a hidden Game's program, and lets others through", async () => {
    await withSwitch("vanguard", async () => undefined);
    const { refuseHiddenGames } = await import("@/server/sponsor/service");
    const { GAME_IDS } = await import("@/lib/chain/games");
    const ix = (programId: PublicKey, extra: PublicKey[] = []) => ({ programId, keys: extra.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })), data: new Uint8Array() });
    expect(() => refuseHiddenGames([ix(GAME_IDS.vanguard)])).toThrow(/not available/);
    expect(() => refuseHiddenGames([ix(PublicKey.default, [GAME_IDS.vanguard])])).toThrow(/not available/);
    expect(() => refuseHiddenGames([ix(GAME_IDS.holdem)])).not.toThrow();
  });
});
