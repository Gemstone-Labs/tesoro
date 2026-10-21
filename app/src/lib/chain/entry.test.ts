import { BN, BorshInstructionCoder, type Idl } from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import coreIdl from "./idl/tesoro_core.json";
import { SIDE_WON, basketPda, countersPda, decodeStore, matchPda, sponsorPda, spillPda, ticketPda, MAX_GROW_LINES } from "./basket";
import { encodeStore, lineOf } from "./basket-fixture";
import {
  backingLimit,
  freshPot,
  growSpillIxs,
  joinFactsOf,
  joinGrowPlan,
  joinMatchIx,
  joinTransaction,
  matchRefKey,
  openMatchIx,
  previewEntry,
  potRentLamports,
  studioRemaining,
  mayPayYourself,
} from "./entry";
import { SponsorError } from "./sponsor-client";
import { planTransaction } from "@/server/sponsor/rules";
import { cancelTicketIx, closeTicketIx, openTicketIx, stageEntryIx, decodeTicket, stagedEntryState } from "./ticket";

const { sendBase, sponsoredSend } = vi.hoisted(() => ({ sendBase: vi.fn(), sponsoredSend: vi.fn() }));

vi.mock("./client", () => ({ getChain: () => ({ base: { getMultipleAccountsInfo: async () => [] }, sendBase }) }));
vi.mock("./sponsor-client", async (orig) => ({ ...(await orig<typeof import("./sponsor-client")>()), sponsorStatus: async () => ({ relayer: Keypair.generate().publicKey.toBase58(), paused: false, low: false }), sponsoredSend }));
vi.mock("./demo-client", () => ({ ensureSol: async () => undefined }));

const coder = new BorshInstructionCoder(coreIdl as unknown as Idl);
const idlIx = (name: string) => (coreIdl.instructions as { name: string; accounts: { name: string; signer?: boolean; optional?: boolean }[] }[]).find((i) => i.name === name)!;
const k = () => Keypair.generate().publicKey;
const [srcA, srcB] = [k(), k()];

const stores = (lines: Parameters<typeof encodeStore>[0], o: Parameters<typeof encodeStore>[1] = {}) => ({ basket: decodeStore(encodeStore(lines, o)), spill: decodeStore(encodeStore([])) });

describe("previewEntry", () => {
  it("is the program's draw: fastest lines first, own before won, Ticket past 16 lines", () => {
    const s = stores([lineOf({ source: srcA, amount: 300n, dueAt: 900n }), lineOf({ source: srcB, amount: 200n, dueAt: 100n }), lineOf({ source: srcA, amount: 90n, side: SIDE_WON, dueAt: 5n })]);
    const p = previewEntry(s, 350n);
    expect(p.steps.map((x) => [x.dueAt, x.take, x.whole])).toEqual([
      [100, 200n, true],
      [900, 150n, false],
    ]);
    expect(p).toMatchObject({ ownGemas: 350n, wonGemas: 0n, dueFirst: 100, dueLast: 900, lineCount: 2, needsTicket: false, potLines: 2, free: 590n });
    expect(p.gemasDueBy(500)).toBe(200n);
    expect(p.sourcesTouched.map((x) => x.toBase58())).toEqual([srcA.toBase58()]);
    const many = stores(Array.from({ length: 40 }, (_, i) => lineOf({ source: srcA, amount: 10n, dueAt: BigInt(i) })));
    const long = previewEntry(many, 300n);
    expect(long).toMatchObject({ needsTicket: true, lineCount: 30, ticketLines: 32, stageTxs: 1 });
    expect(long.potRentLamports).toBe(potRentLamports(32));
  });

  it("refuses what the program refuses: reservations and an open Ticket's need are not free", () => {
    const s = stores([lineOf({ source: srcA, amount: 100n })], { reservedTotal: 40n, ticketNeed: 10n });
    expect(() => previewEntry(s, 51n)).toThrow(/Not enough/);
    expect(previewEntry(s, 50n).entry).toBe(50n);
  });

  it("lets a Backing draw use what its own Offer reserved, never another Offer's", () => {
    const s = stores([lineOf({ source: srcA, amount: 100n })], { reservedTotal: 100n });
    expect(() => previewEntry(s, 60n)).toThrow();
    expect(backingLimit(s, 60n)).toBe(60n);
    expect(previewEntry(s, 60n, { backing: true }).lineCount).toBe(1);
    expect(() => previewEntry(s, 101n, { backing: true })).toThrow();
  });
});

describe("open_match", () => {
  const player = k();
  const payer = k();
  const account = PublicKey.findProgramAddressSync([Buffer.from("account"), player.toBuffer()], new PublicKey(coreIdl.address))[0];
  const game = new PublicKey("CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE");

  it("names every account of the IDL in order, the Player and payer sign, and carries the explicit fields", () => {
    const pot = freshPot(account, 3);
    const ix = openMatchIx({ payer, player, game: "holdem", entry: 500n, n: 7n, challenge: true, asset: 0, pot });
    const spec = idlIx("open_match");
    expect(ix.keys).toHaveLength(spec.accounts.length);
    spec.accounts.forEach((a, i) => expect(ix.keys[i].isSigner, a.name).toBe(!!a.signer && !(a.optional && ix.keys[i].pubkey.equals(new PublicKey(coreIdl.address)))));
    const byName = (n: string) => ix.keys[spec.accounts.findIndex((a) => a.name === n)].pubkey;
    expect(byName("payer")).toEqual(payer);
    expect(byName("player_authority")).toEqual(player);
    expect(byName("basket")).toEqual(basketPda(account));
    expect(byName("spill")).toEqual(spillPda(account));
    expect(byName("counters")).toEqual(countersPda(account));
    expect(byName("pot")).toEqual(pot.address);
    expect(byName("match_state")).toEqual(matchPda(account, 7n));
    expect(byName("offer")).toEqual(new PublicKey(coreIdl.address));
    const decoded = coder.decode(ix.data) as { name: string; data: Record<string, unknown> };
    expect(decoded.name).toBe("open_match");
    expect(String(decoded.data.entry)).toBe("500");
    expect(String(decoded.data.n)).toBe("7");
    expect(decoded.data.challenge).toBe(true);
    expect(decoded.data.asset).toBe(0);
    expect(decoded.data.pot_lines).toBe(3);
    expect(String(decoded.data.pot_nonce)).toBe(pot.nonce.toString());
  });

  it("a backed open names the Backer's accounts and the Offer", () => {
    const backerAccount = k();
    const offer = k();
    const ix = openMatchIx({ payer, player, game: "holdem", entry: 500n, n: 0n, challenge: false, asset: 0, pot: freshPot(backerAccount, 2), backing: { offer, backerAccount } });
    const spec = idlIx("open_match");
    const at = (n: string) => ix.keys[spec.accounts.findIndex((a) => a.name === n)];
    expect(at("offer").pubkey).toEqual(offer);
    expect(at("backer_basket").pubkey).toEqual(basketPda(backerAccount));
    expect(at("backer_counters").isWritable).toBe(true);
  });

  it("the Match key is the opener's Account and counter", () => {
    expect(matchRefKey({ opener: account, n: 12n })).toBe(`${account.toBase58()}-12`);
  });
});

describe("join_match and the holds", () => {
  const player = k();
  const payer = k();
  const opener = k();
  const facts = { game: new PublicKey("CjhY1WkwetHYx56uvqRGGA3XuyShXrALSZkB3GjVusbE"), openerPlayer: opener, openerFunder: opener };

  it("names the IDL's accounts, including the opener baskets when the program has them", () => {
    const ix = joinMatchIx({ payer, player, match: { opener, n: 3n }, facts, pot: freshPot(opener, 2) });
    const spec = idlIx("join_match");
    expect(ix.keys).toHaveLength(spec.accounts.length);
    const at = (n: string) => ix.keys[spec.accounts.findIndex((a) => a.name === n)]?.pubkey;
    expect(at("match_state")).toEqual(matchPda(opener, 3n));
    expect(at("opener_spill")).toEqual(spillPda(opener));
    if (spec.accounts.some((a) => a.name === "opener_basket")) expect(at("opener_basket")).toEqual(basketPda(opener));
    expect((coder.decode(ix.data) as { name: string }).name).toBe("join_match");
  });

  const room = (full: boolean) => ({ basket: decodeStore(encodeStore(full ? [lineOf({ source: srcA, amount: 5n })] : [], { capacity: full ? 1 : 100 })), spill: decodeStore(encodeStore([], { capacity: full ? 0 : 100 })) });

  it("grows a full Account's spill by what its hold needs, and nothing for one with room", () => {
    const joiner = k();
    const f = { game: facts.game, openerPlayer: opener, openerFunder: opener, potLinesA: 3, room: new Map<string, number>(), outsideStudio: null };
    const byKey = new Map([[opener.toBase58(), room(false)], [joiner.toBase58(), room(true)]]);
    const needs = joinGrowPlan(f, 4, joiner, joiner, (a) => byKey.get(a.toBase58()));
    // want = 3 + 4 + 2 = 9 lines for the joiner, whose stores are full; the opener has 200 free slots
    expect(needs).toEqual([{ account: joiner, extraLines: 9 }]);
  });

  it("counts a hold the Account already has, and doubles an outside Studio that also plays", () => {
    const joiner = k();
    const f = { game: facts.game, openerPlayer: opener, openerFunder: opener, potLinesA: 3, room: new Map([[joiner.toBase58(), 4]]), outsideStudio: joiner };
    const byKey = new Map([[opener.toBase58(), room(false)], [joiner.toBase58(), room(true)]]);
    expect(joinGrowPlan(f, 4, joiner, joiner, (a) => byKey.get(a.toBase58()))).toEqual([{ account: joiner, extraLines: 2 * 9 - 4 }]);
    const apart = { ...f, outsideStudio: k(), room: new Map() };
    const studio = apart.outsideStudio;
    byKey.set(studio.toBase58(), room(true));
    const plan = joinGrowPlan(apart, 4, joiner, joiner, (a) => byKey.get(a.toBase58()));
    expect(plan.find((p) => p.account.equals(studio))).toEqual({ account: studio, extraLines: 9 });
  });

  it("splits a big growth at the 71-line limit; the relayer signs and the sponsor is named", () => {
    const relayer = k();
    const ixs = growSpillIxs(relayer, { account: opener, extraLines: 150 });
    expect(ixs).toHaveLength(3);
    const decoded = ixs.map((ix) => (coder.decode(ix.data) as { data: { extra_lines: number; which: object } }).data);
    expect(decoded.map((d) => d.extra_lines)).toEqual([MAX_GROW_LINES, MAX_GROW_LINES, 150 - 2 * MAX_GROW_LINES]);
    expect(Object.keys(decoded[0].which)).toEqual(["Spill"]);
    const spec = idlIx("grow_store_sponsored");
    expect(ixs[0].keys[spec.accounts.findIndex((a) => a.name === "sponsor")].pubkey).toEqual(sponsorPda());
    expect(ixs[0].keys[0].isSigner).toBe(true);
  });

  it("puts the grows before the join, only when sponsored, and sends the excess grows apart", () => {
    const relayer = k();
    const join = joinMatchIx({ payer, player, match: { opener, n: 3n }, facts, pot: freshPot(opener, 2) });
    expect(joinTransaction(false, relayer, [{ account: opener, extraLines: 5 }], join)).toEqual({ earlier: [], main: [join] });
    const one = joinTransaction(true, relayer, [{ account: opener, extraLines: 5 }], join);
    expect(one.main).toHaveLength(2);
    expect(one.main.at(-1)).toBe(join);
    const many = joinTransaction(true, relayer, Array.from({ length: 7 }, () => ({ account: k(), extraLines: 5 })), join);
    expect(many.main.at(-1)).toBe(join);
    expect(many.main.length + many.earlier.flat().length).toBe(8);
    expect(many.main.length - 1).toBeLessThanOrEqual(4);
  });

  it("reads the holds, the Pot size and an outside Studio from a decoded Match", () => {
    const studio = k();
    const state = { inner: { game: facts.game.toBytes(), a: { player: [...opener.toBytes()], funder: [...opener.toBytes()] }, potLines: [3, 0], terms: { studioOwner: [...studio.toBytes()] } }, room: [{ account: [...opener.toBytes()], left: 2 }, { account: [...new Uint8Array(32)], left: 0 }] };
    const f = joinFactsOf(state);
    expect(f.potLinesA).toBe(3);
    expect(f.room.get(opener.toBase58())).toBe(2);
    expect(f.outsideStudio?.toBase58()).toBe(studio.toBase58());
    expect(studioRemaining(studio).map((m) => m.isWritable)).toEqual([true, true]);
    expect(studioRemaining(null)).toEqual([]);
  });
});

describe("what the relayer's allow-list accepts", () => {
  const relayer = k();
  const player = k();
  const playerAccount = PublicKey.findProgramAddressSync([Buffer.from("account"), player.toBuffer()], new PublicKey(coreIdl.address))[0];
  const ctx = { relayer, player, isGame: () => false };
  const asLike = (i: ReturnType<typeof openMatchIx>) => ({ programId: i.programId, keys: i.keys, data: i.data });

  it("a direct open with the relayer as payer is a sponsored admission, the Player the only other signer", () => {
    const open = openMatchIx({ payer: relayer, player, game: "holdem", entry: 500n, n: 1n, challenge: false, asset: 0, pot: freshPot(playerAccount, 4) });
    const plan = planTransaction([asLike(open)], ctx);
    expect(plan.names).toEqual(["open_match"]);
    expect(plan.class).toBe("admission");
  });

  it("a Backing Ticket opens and stages in one transaction with the Requester as the only signer", () => {
    const backerAccount = k();
    const nonce = 9n;
    const ticket = ticketPda(backerAccount, nonce);
    const open = openTicketIx({ payer: relayer, authority: player, owner: backerAccount, nonce, kind: "backing", game: "holdem", target: 500n, lines: 4, offer: k(), sponsored: true });
    const stage = stageEntryIx(player, backerAccount, ticket, 32, []);
    expect(planTransaction([asLike(open), asLike(stage)], ctx).names).toEqual(["open_ticket", "stage_entry"]);
  });

  it("staging, cancelling and closing a Ticket are sponsored continue/exit steps", () => {
    const ticket = ticketPda(playerAccount, 3n);
    expect(planTransaction([asLike(stageEntryIx(player, playerAccount, ticket, 32, []))], ctx).class).toBe("continue");
    expect(planTransaction([asLike(cancelTicketIx(player, playerAccount, ticket, 32, undefined, []))], ctx).class).toBe("exit");
    expect(planTransaction([asLike(closeTicketIx(player, ticket, relayer, true))], ctx).class).toBe("exit");
  });

});

describe("Tickets", () => {
  it("decodes a staged Ticket and says how far along it is", () => {
    const account = k();
    const head = Buffer.alloc(160);
    head[0] = 1;
    head[2] = 0;
    head[3] = 0;
    head.set(account.toBytes(), 8);
    head.set(new PublicKey(coreIdl.address).toBytes(), 40);
    head.set(k().toBytes(), 72);
    head.writeBigUInt64LE(5n, 104);
    head.writeBigUInt64LE(500n, 112);
    head.writeBigInt64LE(2_000n, 120);
    head.writeUInt32LE(8, 128);
    const store = encodeStore([lineOf({ source: srcA, amount: 120n, dueAt: 1n }), lineOf({ source: srcB, amount: 80n, dueAt: 2n })], { capacity: 8, account });
    const data = Buffer.concat([Buffer.alloc(8), head, store.subarray(8)]);
    const t = decodeTicket(k(), data);
    expect(t).toMatchObject({ kind: "entry", state: "open", target: 500n, staged: 200n, lines: 2, lineCap: 8, expiresAt: 2000 });
    expect(t.account.toBase58()).toBe(account.toBase58());
    const st = stagedEntryState(t, 1_000);
    expect(st).toMatchObject({ progress: 0.4, complete: false, cancelling: false, expired: false, expiresIn: 1000 });
    expect(stagedEntryState({ ...t, staged: 500n }, 1_000).complete).toBe(true);
    expect(stagedEntryState({ ...t, state: "cancelling" }, 1_000).cancelling).toBe(true);
    expect(stagedEntryState(t, 2_001)).toMatchObject({ expired: true, expiresIn: 0 });
  });
});

describe("when the Player pays instead", () => {
  it("falls back for a paused or limited relayer, not for a refusal that is the Player's own", () => {
    expect(mayPayYourself(new SponsorError("x", "sponsor-paused", 503))).toBe(true);
    expect(mayPayYourself(new SponsorError("x", "account-limit", 429))).toBe(true);
    expect(mayPayYourself(new SponsorError("x", "no-gemas", 403))).toBe(false);
    expect(mayPayYourself(new Error("boom"))).toBe(false);
  });
});


describe("sendEntryTx", () => {
  beforeEach(() => {
    sendBase.mockReset();
    sponsoredSend.mockReset();
  });
  const signer = { publicKey: Keypair.generate().publicKey, signSerialized: async (b: Uint8Array) => b, signTransaction: async (t: unknown) => t, signMessage: async (m: Uint8Array) => m } as never;

  it("uses the relayer when it can pay, building with the relayer as payer", async () => {
    const { sendEntryTx } = await import("./entry");
    sponsoredSend.mockResolvedValue("sig1");
    const seen: boolean[] = [];
    const r = await sendEntryTx(signer, async () => null, async (_p, sponsored) => (seen.push(sponsored), []));
    expect(r).toEqual({ sig: "sig1", sponsored: true });
    expect(seen).toEqual([true]);
    expect(sendBase).not.toHaveBeenCalled();
  });

  it("pays itself when the relayer is out of free transactions, and when asked not to use it", async () => {
    const { sendEntryTx } = await import("./entry");
    sponsoredSend.mockRejectedValue(new SponsorError("empty", "sponsor-empty", 503));
    sendBase.mockResolvedValue("sig2");
    const seen: boolean[] = [];
    expect(await sendEntryTx(signer, async () => null, async (_p, s) => (seen.push(s), []))).toEqual({ sig: "sig2", sponsored: false });
    expect(seen).toEqual([true, false]);
    sponsoredSend.mockClear();
    expect((await sendEntryTx(signer, async () => null, async () => [], { sponsorable: false })).sponsored).toBe(false);
    expect(sponsoredSend).not.toHaveBeenCalled();
  });

  it("does not pay itself past a refusal that is not about the relayer", async () => {
    const { sendEntryTx } = await import("./entry");
    sponsoredSend.mockRejectedValue(new SponsorError("no gemas", "no-gemas", 403));
    await expect(sendEntryTx(signer, async () => null, async () => [])).rejects.toThrow(/no gemas/);
    expect(sendBase).not.toHaveBeenCalled();
  });
});

void ticketPda;
