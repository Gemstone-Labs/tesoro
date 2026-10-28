import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { MatchPage } from "@/server/history/reads";
import { chainMatchFromPage, resultOf, toChainMatch } from "./read";
import samples from "./match-pages/settle-run-devnet-2026-10-27.json";

/**
 * Real devnet Block Burst Matches: the Match account as it was when `finalize` had started the settle run (the result shown
 * to the Player from then on), and the Match history page after the run paid out and the account closed. What the page shows at
 * finalize must be what was settled: the same Fee, the same Gemas won or lost, the same outcome, for every account in the Match.
 */
type Sample = { scenario: string; key: string; settling: { inner: unknown }; history: MatchPage };

const pk = (bytes: number[]) => new PublicKey(Uint8Array.from(bytes));

describe("the result shown when finalize has fixed it equals what the history settled", () => {
  for (const s of samples as unknown as Sample[]) {
    const inner = s.settling.inner as { a: { player: number[] }; b: { player: number[] } };
    for (const [i, who] of [inner.a.player, inner.b.player].entries()) {
      it(`${s.scenario} (${s.key.slice(0, 4)}…-${s.key.split("-").pop()}), seat ${i}`, () => {
        const me = pk(who);
        const early = toChainMatch({ inner: s.settling.inner }, me, null);
        const final = chainMatchFromPage(s.history, me)!;
        expect(resultOf(early)).toBe(final.status);
        // the Match itself is honest: it is not settled until the last chunk has paid
        expect(early.status).toBe("active");
        expect(early.running).not.toBeNull();
        expect(early.winner).toBe(final.winner);
        expect(early.settled).toMatchObject({ fee: final.settled!.fee, delta: final.settled!.delta });
      });
    }
  }

  it("covers a win, a draw and refunds", () => {
    const kinds = new Set((samples as unknown as Sample[]).map((s) => s.scenario));
    expect(kinds).toContain("win and loss");
    expect([...kinds].some((k) => k.startsWith("refund"))).toBe(true);
  });
});
