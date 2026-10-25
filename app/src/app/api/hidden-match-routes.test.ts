import { afterEach, describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/server/history/db", () => ({ supabaseRpc: rpc }));
afterEach(() => { vi.unstubAllEnvs(); vi.resetAllMocks(); });
const address = "11111111111111111111111111111111";

describe("direct Match endpoints respect game visibility", () => {
  for (const hidden of ["vanguard", ""]) {
    for (const game of ["vanguard", "holdem"]) {
      it(`returns ${hidden === game ? 404 : 200} for ${game} when hidden=${hidden}`, async () => {
        vi.resetModules();
        vi.stubEnv("NEXT_PUBLIC_HIDDEN_GAMES", hidden);
        rpc.mockResolvedValue({ game, status: "settled", state: { game } });
        const match = await import("./match/[key]/route");
        const end = await import("./end-state/[match]/route");
        const status = hidden === game ? 404 : 200;
        const req = new Request("http://localhost/api/match/test");
        const responses = await Promise.all([
          match.GET(req, { params: Promise.resolve({ key: `${address}-1` }) }),
          end.GET(req, { params: Promise.resolve({ match: address }) }),
        ]);
        for (const response of responses) {
          expect(response.status).toBe(status);
          if (status === 404) expect(JSON.stringify(await response.json())).not.toContain(game);
        }
      });
    }
  }
});
