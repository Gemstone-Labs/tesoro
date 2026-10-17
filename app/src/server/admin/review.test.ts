import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { newNonce, signedMessage } from "../../lib/chain/signed-request";
import { SEASON_EPOCH, SEASON_SECS } from "../../lib/chain/season";
import { DemoHttpError, type AuthEnv } from "../request-auth";
import { handleReview, parseAdmins, reviewSeasons, type ReviewDeps } from "./review";

const NOW = (SEASON_EPOCH + SEASON_SECS + 3600) * 1000; // 1 hour into Season 2
const dev: AuthEnv = { production: false, devWallet: true, verifyToken: async () => null };
const admin = Keypair.generate();
const other = Keypair.generate();

const wins = Array.from({ length: 8 }, (_, i) => ({ player: "B", loser: "A", matchId: `${i}`, points: 1, ts: 1 }));
const deps = (admins: string[]): ReviewDeps => ({ admins, load: async (s) => s.map((season) => ({ season, wins, runs: [] })) });

function signed(kp: Keypair, step = "review") {
  const address = kp.publicKey.toBase58();
  const nonce = newNonce();
  const sig = nacl.sign.detached(new TextEncoder().encode(signedMessage("tesoro-admin", step, address, NOW, nonce, {})), kp.secretKey);
  return { step, address, ts: NOW, nonce, signature: Buffer.from(sig).toString("base64") };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof DemoHttpError ? e.code : String(e);
  }
};

describe("review route auth", () => {
  const d = deps([admin.publicKey.toBase58()]);
  it("refuses an unsigned request", async () => {
    expect(await code(handleReview(d, {}, null, dev, NOW))).toBe("bad-request");
    expect(await code(handleReview(d, null, null, dev, NOW))).toBe("bad-request");
  });
  it("refuses a bad signature", async () => {
    expect(await code(handleReview(d, { ...signed(admin), signature: Buffer.alloc(64).toString("base64") }, null, dev, NOW))).toBe("bad-signature");
  });
  it("refuses a wallet that is not an admin", async () => {
    expect(await code(handleReview(d, signed(other), null, dev, NOW))).toBe("forbidden");
  });
  it("refuses everyone while no admin is configured", async () => {
    expect(await code(handleReview(deps([]), signed(admin), null, dev, NOW))).toBe("not-configured");
  });
  it("refuses a replayed request", async () => {
    const body = signed(admin);
    await handleReview(d, body, null, dev, NOW);
    expect(await code(handleReview(d, body, null, dev, NOW))).toBe("replayed");
  });
  it("answers the admin wallet with flags for this Season and the one in its payout window", async () => {
    const reply = await handleReview(d, signed(admin), null, dev, NOW);
    expect(reply.seasons.map((s) => s.number)).toEqual([2, 1]);
    expect(reply.flags.map((f) => f.season)).toEqual([2, 1]);
    expect(reply.flags[0]).toMatchObject({ kind: "pair", account: "B" });
  });
});

describe("reviewSeasons", () => {
  it("drops the previous Season after its 48-hour window", () => {
    const start2 = SEASON_EPOCH + SEASON_SECS;
    expect(reviewSeasons(start2 + 47 * 3600).map((s) => s.number)).toEqual([2, 1]);
    expect(reviewSeasons(start2 + 49 * 3600).map((s) => s.number)).toEqual([2]);
    expect(reviewSeasons(SEASON_EPOCH - 1)).toEqual([]);
  });
});

describe("parseAdmins", () => {
  it("splits and trims", () => {
    expect(parseAdmins(" a, b ,,c")).toEqual(["a", "b", "c"]);
    expect(parseAdmins(undefined)).toEqual([]);
  });
});
