import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
const lb = vi.hoisted(() => ({ value: { data: null, forMe: false, error: false } as { data: unknown; forMe: boolean; error: boolean } }));
vi.mock("@/lib/chain/useLeaderboard", () => ({ useLeaderboard: () => ({ ...lb.value, retry: () => undefined }) }));
const acct = vi.hoisted(() => ({ snapshot: null as { matches: unknown[]; accountKey: { toBase58(): string }; waiting?: unknown[] } | null, rows: [] as unknown[] }));
vi.mock("@/lib/account", async (orig) => ({ ...(await orig<typeof import("@/lib/account")>()), useAccount: () => ({ auth: { status: "signed-in", addresses: { solana: "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ" } }, snapshot: acct.snapshot }) }));
vi.mock("@/lib/friends/useRecordRows", () => ({ useRecordRows: () => (acct.snapshot ? acct.rows : null) }));
const fr = vi.hoisted(() => ({ status: "ready" as string, relation: "none" as string }));
vi.mock("@/lib/friends/FriendsProvider", async (orig) => ({ ...(await orig<typeof import("@/lib/friends/FriendsProvider")>()), useFriends: () => ({ status: fr.status, relation: () => fr.relation, act: async () => ({}) }) }));
import { PublicKey } from "@solana/web3.js";
import { matchPda } from "@/lib/chain/basket";
import { MatchResult, type MatchResultProps } from "./MatchResult";

const SNAP = { matches: [], accountKey: { toBase58: () => "me" } };
const OPP = "6qPLGMP5pY9KXQ8PVr8V8cjiWNdy3tzfKnf85e5wQmoZ";
const base: MatchResultProps = { game: "block-puzzle", outcome: "won", delta: 440, entry: 500, role: "player", backed: false, playAgainHref: "/play/queue", opponent: OPP, points: 5, matchId: "7" };
const html = (over: Partial<MatchResultProps> = {}) => renderToStaticMarkup(<MatchResult {...base} {...over} />);

const k = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const waitingFor = (n: number, gemas: bigint) => ({ address: k(n), owner: k(2), payer: k(3), kind: 0, match: matchPda(k(9), n), gemas, lines: 1, storeLines: [], sources: [k(4)] });
const KEY = `${k(9).toBase58()}-7`;

describe("Gemas waiting for room on the result", () => {
  afterEach(() => { acct.snapshot = null; });
  it("says how many wait, with a Claim, only for this Match's record", () => {
    acct.snapshot = { ...SNAP, waiting: [waitingFor(7, 95n), waitingFor(8, 71n)] };
    const h = html({ matchId: KEY });
    expect(h).toContain("95 Gemas waiting for room");
    expect(h).not.toContain("71 Gemas");
    expect(h).toContain(">Claim<");
  });
  it("shows nothing when no record of this Match exists, or after a Claim cleared it", () => {
    acct.snapshot = { ...SNAP, waiting: [waitingFor(8, 71n)] };
    expect(html({ matchId: KEY })).not.toContain("waiting for room");
    acct.snapshot = SNAP;
    expect(html({ matchId: KEY })).not.toContain("waiting for room");
  });
});

describe("the result screen", () => {
  afterEach(() => {
    acct.snapshot = null;
    acct.rows = [];
  });
  it("shows no scores, even when a caller still passes them (founder 2026-10-29)", () => {
    const old = { ...base, scores: ["171", "55"] };
    const h = renderToStaticMarkup(<MatchResult {...old} />);
    expect(h).not.toContain(">Opponent<");
    expect(h).not.toContain(">You<");
    expect(h).not.toContain("171");
  });
  it("says nothing under a loss beyond the result itself", () => {
    expect(html({ outcome: "lost", delta: -500, points: 0 })).not.toContain("Your entry went to the winner");
  });
  it("shows the settled gain, Season tile first and the record tile second, and no Fee tile", () => {
    const h = html();
    expect(h).toContain("440");
    expect(h).toMatch(/Season · \+5/);
    expect(h.indexOf("Season")).toBeLessThan(h.indexOf("vs "));
    expect(h).not.toContain(">Fee<");
  });
  it("shows the Season tile after a loss: 0 points and Not ranked yet once the Leaderboard is read", () => {
    lb.value = { data: { feeBps: 0, rows: [] }, forMe: true, error: false };
    const h = html({ outcome: "lost", delta: -500, points: 0 });
    expect(h).toMatch(/Season · \+0/);
    expect(h).toContain("Not ranked yet");
    lb.value = { data: null, forMe: false, error: false };
  });
  it("keeps the rank blank while the Leaderboard loads, never Not ranked yet", () => {
    const h = html({ outcome: "lost", delta: -500, points: 0 });
    expect(h).not.toContain("Not ranked yet");
    expect(h).toContain("aria-busy");
  });
  it("shows no Season points after a win until the history has them, instead of a guess the cap may change", () => {
    const h = html({ points: undefined });
    expect(h).not.toMatch(/Season · \+/);
    expect(h).toContain("Season");
  });
  describe("record tile", () => {
    const row = (id: string, result: string, opp = OPP, role = "player") => ({ id, role, result, opp });
    it("is blank while the history loads", () => {
      acct.snapshot = null;
      const h = html();
      expect(h).toContain("aria-busy");
      expect(h).toContain("Challenge");
    });
    it("counts this Match when the history does not list it yet, over all games", () => {
      acct.snapshot = SNAP;
      acct.rows = [row("1", "won"), row("2", "won"), row("3", "lost"), row("4", "won", "someone-else")];
      expect(html()).toMatch(/<b>3 – 1<\/b>/);
    });
    it("does not count this Match twice once the history has it", () => {
      acct.snapshot = SNAP;
      acct.rows = [row("7", "won"), row("3", "lost")];
      expect(html()).toMatch(/<b>1 – 1<\/b>/);
    });
    it("shows a loss and mentions draws", () => {
      acct.snapshot = SNAP;
      acct.rows = [row("1", "draw")];
      const h = html({ outcome: "lost", delta: -500, points: 0 });
      expect(h).toMatch(/0 – 1<small>1 draw<\/small>/);
    });
    it("links to a Challenge for the same Game and entry against the opponent", () => {
      acct.snapshot = SNAP;
      acct.rows = [];
      expect(html()).toContain(`href="/play/challenge?entry=500&amp;opponent=${OPP}"`);
      expect(html({ game: "holdem" })).toContain(`href="/play/challenge?game=holdem&amp;entry=500&amp;opponent=${OPP}"`);
    });
    it("is not shown after a refund, to a Backer, or without a known opponent", () => {
      acct.snapshot = SNAP;
      for (const over of [{ outcome: "refunded" as const, delta: 0 }, { role: "backer" as const }, { opponent: null }]) expect(html(over)).not.toContain("Challenge");
    });
  });
  it("shows no tiles at all after a refund: no Season, no Fee", () => {
    const h = html({ outcome: "refunded", delta: 0, points: 0 });
    expect(h).not.toContain("mr-tiles");
    expect(h).not.toContain("Season");
    expect(h).not.toContain("Challenge");
  });
  it("gives Play again the whole row once the opponent is a Friend, and while the Friends list loads", () => {
    for (const [status, relation] of [["ready", "friend"], ["loading", "none"]]) {
      fr.status = status;
      fr.relation = relation;
      const h = html();
      expect(h).toContain("Play again");
      expect(h).not.toContain("Add friend");
      expect(h).not.toMatch(/>Friends</);
    }
    fr.status = "ready";
    fr.relation = "none";
  });
  it("has exactly Play again and Add friend as actions", () => {
    const h = html();
    expect(h).toContain("Play again");
    expect(h).toContain("Add friend");
    for (const gone of ["Rematch", "Practice free", "Back to games", "Vault", "Losses earn no points", "Entry"]) expect(h).not.toContain(gone);
  });
  it("has no Add friend without a known opponent", () => {
    expect(html({ opponent: null, outcome: "refunded", delta: 0, points: 0 })).not.toContain("Add friend");
  });
});
