import { describe, expect, it } from "vitest";
import { BN } from "@coral-xyz/anchor";
import { SystemProgram, ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { accountOf, backingPairIx, chunkIx, coreIx, createAccountIx, growIx, linkEvmBridgeIx, signUpIx, joinMatchIx, key, openMatchIx, playerIx } from "./fixtures";
import { CORE_ID, ORDER_RENT, RECEIPT_RENT, ROWS, TX_SHAPES, planTransaction, type Ix } from "./rules";
import { GAME_IDS } from "@/lib/chain/games";

const relayer = key();
const player = key();
const game = key();
const ctx = { relayer, player, isGame: (p: { equals(o: unknown): boolean }) => p.equals(game) };
const plan = (ixs: Ix[]) => planTransaction(ixs, ctx);
const refused = (ixs: Ix[], code: string) => expect(() => plan(ixs)).toThrowError(expect.objectContaining({ code }));

describe("the table matches the program", () => {
  const ixs = (coreIdl as { instructions: { name: string; accounts: { name: string }[] }[] }).instructions;
  it("every row names a real instruction and real relayer slots", () => {
    for (const [name, row] of Object.entries(ROWS)) {
      const ix = ixs.find((i) => i.name === name);
      expect(ix, name).toBeTruthy();
      for (const slot of row.relayer) expect(ix!.accounts.map((a) => a.name), `${name}.${slot}`).toContain(slot);
    }
  });
  it("every shape is built from rows", () => {
    for (const shape of TX_SHAPES) for (const n of shape) expect(ROWS[n], n).toBeTruthy();
  });
  it("sponsoring never covers admin or treasury instructions", () => {
    for (const n of ["set_sponsor", "init_sponsor", "withdraw_treasury", "set_admin", "register_game", "list_game", "update_config", "settle_match"]) expect(ROWS[n], n).toBeUndefined();
  });
});

describe("accepted", () => {
  it("an open_match with the relayer as payer is an admission that fronts a deposit", async () => {
    const p = plan([await openMatchIx(relayer, player, game)]);
    expect(p).toMatchObject({ kind: "core", names: ["open_match"], class: "admission" });
    expect(p.spend.refundable).toBeGreaterThan(0n);
    expect(p.signers.map((k) => k.toBase58())).toEqual([player.toBase58()]);
  });
  it("a chunk is an exit with the relayer as caller, and may carry many Source accounts", async () => {
    const p = plan([await chunkIx(relayer, key(), 60)]);
    expect(p).toMatchObject({ names: ["match_chunk"], class: "exit" });
    expect(p.signers).toEqual([]);
  });
  it("stages a fragmented entry with the Source books and pages required by the draw", async () => {
    const owner = accountOf(player);
    const ix = await coreIx("stage_entry", [32], { signer: player, owner, ticket: key() });
    for (let i = 0; i < 4; i++) ix.keys.push({ pubkey: key(), isSigner: false, isWritable: true });
    expect(plan([ix])).toMatchObject({ names: ["stage_entry"], class: "continue" });
    ix.keys.at(-1)!.isSigner = true;
    refused([ix], "bad-accounts");
    ix.keys.at(-1)!.isSigner = false;
    ix.keys.at(-1)!.pubkey = relayer;
    refused([ix], "bad-accounts");
    ix.keys.at(-1)!.pubkey = key();
    for (let i = 4; i < 61; i++) ix.keys.push({ pubkey: key(), isSigner: false, isWritable: true });
    refused([ix], "bad-accounts");
  });
  it("a Game instruction without the relayer, signed by the Player, for a listed Game", () => {
    const p = plan([{ programId: game, keys: [{ pubkey: player, isSigner: true, isWritable: true }, { pubkey: key(), isSigner: false, isWritable: true }], data: new Uint8Array([1, 2, 3]) }]);
    expect(p).toMatchObject({ kind: "game", class: "continue" });
  });
});

describe("refused", () => {
  it("refuses a known Trading Duel's unsupported asset before the keeper pays to assign it", async () => {
    const ix = await openMatchIx(relayer, player, GAME_IDS["trading-duel"]);
    ix.data = new Uint8Array(ix.data);
    // open_match: discriminator8, game32, entry8, counter8, nonce8, challenge1, asset1.
    ix.data[65] = 255;
    refused([ix], "bad-asset");
  });
  it("the relayer anywhere but its slot, writable or not", async () => {
    const ix = await chunkIx(relayer, key());
    const potA = ix.keys.findIndex((k) => k.isWritable && !k.isSigner);
    ix.keys[potA] = { pubkey: relayer, isSigner: false, isWritable: true };
    refused([ix], "relayer-in-accounts");
    const open = await openMatchIx(relayer, player, game);
    const basket = open.keys.findIndex((k) => k.pubkey.equals(open.keys[10].pubkey));
    open.keys[basket] = { pubkey: relayer, isSigner: false, isWritable: true };
    refused([open], "relayer-in-accounts");
  });
  it("an extra account on an instruction that takes none", async () => {
    const close = await coreIx("close_ticket", [], { caller: relayer, ticket: key(), payer: relayer });
    close.keys.push({ pubkey: key(), isSigner: false, isWritable: false });
    refused([close], "bad-accounts");
  });
  it("more Source and store accounts than an open or a join may carry, and a signer among them", async () => {
    for (const make of [openMatchIx, joinMatchIx]) {
      const many = await make(relayer, player, game);
      for (let i = 0; i < 61; i++) many.keys.push({ pubkey: key(), isSigner: false, isWritable: true });
      refused([many], "bad-accounts");
      const signing = await make(relayer, player, game);
      signing.keys.push({ pubkey: key(), isSigner: true, isWritable: true });
      refused([signing], "bad-accounts");
    }
  });
  it("more chunk accounts than the row allows, and a signer among them", async () => {
    refused([await chunkIx(relayer, key(), 61)], "bad-accounts");
    const ix = await chunkIx(relayer, key(), 2);
    ix.keys[ix.keys.length - 1].isSigner = true;
    refused([ix], "bad-accounts");
  });
  it("a wrong signer or writable flag", async () => {
    const open = await openMatchIx(relayer, player, game);
    open.keys[1].isSigner = false;
    refused([open], "bad-flags");
    const open2 = await openMatchIx(relayer, player, game);
    open2.keys[2].isWritable = true;
    refused([open2], "bad-flags");
  });
  it("a PDA that is not the one the program derives", async () => {
    const open = await openMatchIx(relayer, player, game);
    open.keys[11] = { ...open.keys[11], pubkey: key() };
    refused([open], "bad-account");
  });
  it("the Player's own Account swapped for another Account", async () => {
    const other = key();
    const open = await openMatchIx(relayer, player, game, { playerAccount: other });
    refused([open], "bad-account");
  });
  it("unknown programs: System transfer, compute budget, an unlisted Game", async () => {
    refused([SystemProgram.transfer({ fromPubkey: relayer, toPubkey: player, lamports: 1 })], "unknown-program");
    refused([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 })], "unknown-program");
    refused([{ programId: key(), keys: [], data: new Uint8Array([1]) }], "unknown-program");
  });
  it("Core instructions that are not in the table, and unknown discriminators", async () => {
    refused([await coreIx("set_sponsor", [relayer, false, new BN(1), new BN(1), new BN(1)], { admin: player })], "unknown-instruction");
    refused([{ programId: CORE_ID, keys: [], data: new Uint8Array(8) }], "unknown-instruction");
  });
  it("a Game instruction naming the relayer, or signed by someone else", () => {
    const base = { programId: game, data: new Uint8Array([1]) };
    refused([{ ...base, keys: [{ pubkey: relayer, isSigner: false, isWritable: false }] }], "relayer-in-accounts");
    refused([{ ...base, keys: [{ pubkey: key(), isSigner: true, isWritable: false }] }], "bad-signer");
  });
  it("shapes the table does not list: an open never travels with a grow, grows never follow a join", async () => {
    const open = await openMatchIx(relayer, player, game);
    refused([open, open], "bad-shape");
    const grow = await growIx(relayer, key());
    expect(plan([grow]).class).toBe("admission");
    refused([grow, open], "bad-shape");
    refused([await joinMatchIx(relayer, player, game), grow], "bad-shape");
    refused([grow, grow, grow, grow, grow, grow], "bad-shape");
  });
  it("a join may be preceded by the grows of the Accounts it holds room in (ticket 09b)", async () => {
    const join = await joinMatchIx(relayer, player, game);
    const alone = plan([join]);
    expect(alone.names).toEqual(["join_match"]);
    for (let n = 1; n <= 5; n++) {
      const grows = await Promise.all(Array.from({ length: n }, () => growIx(relayer, key())));
      const p = plan([...grows, join]);
      expect(p.names).toEqual([...Array(n).fill("grow_store_sponsored"), "join_match"]);
      expect(p.class).toBe("admission");
      expect(p.signers.map((k) => k.toBase58())).toEqual([player.toBase58()]);
      expect(p.spend.refundable).toBeGreaterThan(alone.spend.refundable);
      expect(p.cu).toBeLessThanOrEqual(1_400_000);
    }
  });
  it("grows alone are a shape, and the relayer is only the grow's relayer slot", async () => {
    expect(plan([await growIx(relayer, key()), await growIx(relayer, key())]).names).toHaveLength(2);
    const grow = await growIx(relayer, key());
    const account = grow.keys.findIndex((k) => !k.isSigner && !k.isWritable && !k.pubkey.equals(CORE_ID) && !k.pubkey.equals(relayer));
    grow.keys[account] = { ...grow.keys[account], pubkey: relayer };
    refused([grow], "relayer-in-accounts");
  });
  it("empty and oversized transactions", async () => {
    refused([], "bad-shape");
    const open = await openMatchIx(relayer, player, game);
    refused(Array(5).fill(open), "bad-shape");
  });
});

describe("the Player's own exits and orders (ticket 18b)", () => {
  const exits = {
    redeem: playerIx.redeem,
    redeem_prize: playerIx.redeemPrize,
    unlock: playerIx.unlock,
    return_own: playerIx.returnOwn,
    cancel_instant_redeem: (a: typeof player) => playerIx.cancelInstantRedeem(a),
    expire_instant_redeem: (a: typeof player) => playerIx.expireInstantRedeem(a),
    cancel_offer: (a: typeof player) => playerIx.cancelOffer(a),
    cancel_request: (a: typeof player) => playerIx.cancelRequest(a),
    claim_free_yield: playerIx.claimFreeYield,
  };
  for (const [name, build] of Object.entries(exits)) {
    it(`${name}: an exit signed by the Player, the relayer is only the fee payer`, async () => {
      const p = plan([await build(player)]);
      expect(p).toMatchObject({ names: [name], class: "exit" });
      expect(p.signers.map((k) => k.toBase58())).toEqual([player.toBase58()]);
      expect(p.playerSigns).toBe(true);
    });
    it(`${name}: refuses an extra account and the relayer in any account`, async () => {
      const ix0 = await build(player);
      const extra = { ...ix0, keys: [...ix0.keys, { pubkey: key(), isSigner: true, isWritable: false }] };
      refused([extra], "bad-accounts");
      const ix = await build(player);
      const i = ix.keys.findIndex((k) => k.isWritable && !k.isSigner);
      ix.keys[i] = { pubkey: relayer, isSigner: false, isWritable: true };
      refused([ix], "relayer-in-accounts");
      const asSigner = await build(player);
      asSigner.keys[0] = { pubkey: relayer, isSigner: true, isWritable: asSigner.keys[0].isWritable };
      refused([asSigner], "relayer-in-accounts");
    });
  }
  it("redeem may carry the books of the Sources it touches, never a signer", async () => {
    const ix = await playerIx.redeem(player);
    ix.keys.push({ pubkey: key(), isSigner: false, isWritable: true }, { pubkey: key(), isSigner: false, isWritable: false });
    expect(plan([ix]).names).toEqual(["redeem"]);
    ix.keys.push({ pubkey: key(), isSigner: true, isWritable: false });
    refused([ix], "bad-accounts");
  });
  it("the beginner pack (open + Advance) is one admission signed by the Player, the relayer only pays the fee", async () => {
    for (const [open, take] of [
      [playerIx.openNativePosition, playerIx.takeNativeAdvance],
      [playerIx.openStakePosition, playerIx.takeStakeAdvance],
    ] as const) {
      const p = plan([await open(player), await take(player)]);
      expect(p.class).toBe("admission");
      expect(p.playerSigns).toBe(true);
      expect(p.signers.map((k) => k.toBase58())).toEqual([player.toBase58()]);
      expect(p.spend).toEqual({ refundable: 0n, sunk: 0n });
    }
    // other pairings and a lone relayer-owned instruction are not on the list
    refused([await playerIx.openNativePosition(player), await playerIx.takeStakeAdvance(player)], "bad-shape");
    refused([await playerIx.takeNativeAdvance(relayer)], "relayer-in-accounts");
  });
  it("request_instant_redeem: the holder pays, or the relayer pays and the sponsor repays it", async () => {
    const own = plan([await playerIx.requestInstantRedeem(player)]);
    expect(own).toMatchObject({ names: ["request_instant_redeem"], class: "admission" });
    const sponsored = plan([await playerIx.requestInstantRedeem(player, relayer, true)]);
    expect(sponsored.spend.refundable).toBe(ORDER_RENT);
    expect(sponsored.signers.map((k) => k.toBase58())).toEqual([player.toBase58()]);
    // the relayer never pays an order's rent without the sponsor account to repay it, or stands anywhere else
    refused([await playerIx.requestInstantRedeem(player, relayer, false)], "bad-accounts");
    const holder = await playerIx.requestInstantRedeem(relayer, relayer, true);
    refused([holder], "relayer-in-accounts");
  });
  it("cancel and expire may name the relayer as the order's payer only with the sponsor account", async () => {
    for (const make of [playerIx.cancelInstantRedeem, playerIx.expireInstantRedeem]) {
      expect(plan([await make(player, key(), relayer, true)]).class).toBe("exit");
      refused([await make(player, key(), relayer, false)], "bad-accounts");
    }
  });
  it("an exit cannot ride along with another instruction", async () => {
    refused([await playerIx.unlock(player), await playerIx.unlock(player)], "bad-shape");
  });
});

describe("a Backing Ticket opened and staged in one transaction", () => {
  it("is an admission signed by the Requester alone, and names whose lines fund it", async () => {
    const { ixs, requester, backerAccount } = await backingPairIx(relayer);
    const p = plan(ixs);
    expect(p).toMatchObject({ names: ["open_ticket", "stage_entry"], class: "admission" });
    expect(p.signers.map((k) => k.toBase58())).toEqual([requester.toBase58()]);
    expect(p.funders.map((k) => k.toBase58())).toEqual([backerAccount.toBase58()]);
  });
  it("is refused when stage_entry is for another Ticket or another Account", async () => {
    const a = await backingPairIx(relayer);
    a.ixs[1].keys[4] = { ...a.ixs[1].keys[4], pubkey: key() };
    refused(a.ixs, "bad-shape");
    const b = await backingPairIx(relayer);
    const other = await backingPairIx(relayer);
    b.ixs[1] = other.ixs[1];
    refused(b.ixs, "bad-shape");
  });
  it("is refused with the relayer, or anyone but the Requester, as the signer of stage_entry", async () => {
    const a = await backingPairIx(relayer);
    a.ixs[1].keys[0] = { pubkey: relayer, isSigner: true, isWritable: false };
    refused(a.ixs, "relayer-in-accounts");
    const b = await backingPairIx(relayer);
    b.ixs[1].keys[0] = { pubkey: key(), isSigner: true, isWritable: false };
    refused(b.ixs, "bad-shape");
  });
});

describe("a sponsored new Account (ticket 18c)", () => {
  const invite = key();
  it("a lone create_account with the relayer as payer and the sponsor attached is an onboarding admission", async () => {
    const p = plan([await createAccountIx(relayer, player)]);
    expect(p).toMatchObject({ names: ["create_account"], class: "admission", onboarding: true, invite: false });
    expect(p.signers.map((k) => k.toBase58())).toEqual([player.toBase58()]);
    expect(p.spend.refundable).toBeGreaterThan(0n);
    expect(p.spend.sunk).toBeGreaterThan(0n);
  });
  it("the wallet paying for itself is the same shape with the relayer only on the fee", async () => {
    const p = plan([await createAccountIx(relayer, player, { sponsored: false, payer: player })]);
    expect(p.onboarding).toBe(true);
  });
  it("the relayer as payer without the sponsor account is refused: its rent would never come back", async () => {
    refused([await createAccountIx(relayer, player, { sponsored: false })], "bad-accounts");
  });
  it("travels alone: nothing is paid for next to it", async () => {
    refused([await createAccountIx(relayer, player), await growIx(relayer, accountOf(player))], "bad-shape");
  });
  it("the Invite key may co-sign, and only the key the server holds", async () => {
    const withInvite = await createAccountIx(relayer, player, { invite });
    expect(planTransaction([withInvite], { ...ctx, inviteKey: invite })).toMatchObject({ onboarding: true, invite: true });
    expect(() => planTransaction([withInvite], ctx)).toThrowError(expect.objectContaining({ code: "bad-accounts" }));
    expect(() => planTransaction([withInvite], { ...ctx, inviteKey: key() })).toThrowError(expect.objectContaining({ code: "bad-accounts" }));
    const stranger = await createAccountIx(relayer, player, { invite: key() });
    expect(() => planTransaction([stranger], { ...ctx, inviteKey: invite })).toThrowError(expect.objectContaining({ code: "bad-accounts" }));
  });
  it("any other extra account is refused", async () => {
    const ix = await createAccountIx(relayer, player);
    ix.keys.push({ pubkey: key(), isSigner: false, isWritable: false });
    expect(() => planTransaction([ix], { ...ctx, inviteKey: invite })).toThrowError(expect.objectContaining({ code: "bad-accounts" }));
  });
});

describe("the rest of sign-up (ticket 18c)", () => {
  it("a Profile is a continue step the relayer fronts, with the sponsor attached", async () => {
    expect(plan([await signUpIx.profile(relayer, player)])).toMatchObject({ names: ["set_profile"], class: "continue", onboarding: false });
    expect(plan([await signUpIx.nameEvmCleared(relayer, player)])).toMatchObject({ names: ["set_name_evm"], class: "continue" });
  });
  it("the relayer is never the Profile's payer without the sponsor, and the wallet may pay itself", async () => {
    refused([await signUpIx.profile(relayer, player, { sponsored: false })], "bad-accounts");
    refused([await signUpIx.nameEvmCleared(relayer, player, { sponsored: false })], "bad-accounts");
    expect(plan([await signUpIx.profile(relayer, player, { sponsored: false, payer: player })]).names).toEqual(["set_profile"]);
  });
  it("setting the EVM address costs the relayer only the fee", async () => {
    expect(plan([await signUpIx.evmAddress(player)])).toMatchObject({ names: ["set_evm_address"], class: "continue" });
  });
  it("naming a Solana wallet needs a second signature and is not sponsored", async () => {
    refused([await signUpIx.nameWallet(player)], "unknown-instruction");
  });
  it("link_evm is an admission without Gemas whose rent is the relayer's, counted as sunk", () => {
    const p = plan([linkEvmBridgeIx(player, relayer)]);
    expect(p).toMatchObject({ names: ["link_evm"], class: "admission", noGemas: true, playerSigns: true });
    expect(p.spend.sunk).toBeGreaterThan(0n);
    expect(p.signers.map((k) => k.toBase58())).toEqual([player.toBase58()]);
  });
  it("link_evm in any other shape is refused", () => {
    const good = () => linkEvmBridgeIx(player, relayer);
    const wrongPayer = good();
    wrongPayer.keys[4] = { ...wrongPayer.keys[4], pubkey: key() };
    refused([wrongPayer], "relayer-in-accounts");
    const wrongLink = good();
    wrongLink.keys[2] = { ...wrongLink.keys[2], pubkey: key() };
    refused([wrongLink], "bad-account");
    const wrongFlag = good();
    wrongFlag.keys[0] = { ...wrongFlag.keys[0], isWritable: true };
    refused([wrongFlag], "bad-flags");
    const other = good();
    other.data = new Uint8Array(other.data.length);
    refused([other], "bad-shape");
    refused([good(), good()], "bad-shape");
    const wrongAccount = good();
    wrongAccount.keys[1] = { ...wrongAccount.keys[1], pubkey: key() };
    refused([wrongAccount], "bad-account");
  });
});

describe("Block Burst Live (ticket 28)", () => {
  it("a 0-SOL Player's open and join are both sponsored: the Session is gone, so nothing else travels with them", async () => {
    expect(plan([await openMatchIx(relayer, player, game)]).names).toEqual(["open_match"]);
    expect(plan([await joinMatchIx(relayer, player, game)]).names).toEqual(["join_match"]);
  });
  it("the Player's own refund is sponsored: the relayer pays the receipt, the Player signs as the caller", async () => {
    const ix = await coreIx("refund_match", [], { caller: player, payer: relayer, gameProgram: game, programData: key(), gameRecord: key(), matchState: key(), openerProtections: null });
    expect(plan([ix])).toMatchObject({ names: ["refund_match"], class: "exit" });
  });
  it("a listed Game's finalize, signed by the Player, is a game transaction; the relayer in its accounts is refused", () => {
    const finalize = (extra: { pubkey: typeof relayer; isSigner: boolean; isWritable: boolean }[]) => ({
      programId: game,
      keys: [{ pubkey: player, isSigner: true, isWritable: true }, { pubkey: key(), isSigner: false, isWritable: true }, ...extra],
      data: new Uint8Array([0xf2, 0x3c, 0x6e, 0xb6, 0x3a, 0x95, 0xd1, 0x9b]),
    });
    expect(plan([finalize([])])).toMatchObject({ kind: "game", class: "continue" });
    refused([finalize([{ pubkey: relayer, isSigner: false, isWritable: true }])], "relayer-in-accounts");
  });
  describe("a listed Game's finalize with the relayer as caller (ticket 04: the winner pays no SOL)", () => {
    const FINALIZE = new Uint8Array([171, 61, 218, 56, 127, 115, 12, 217]);
    const k = (pubkey = key(), isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });
    const assignmentOf = (match: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("assign"), match.toBuffer()], game)[0];
    const fin = (over: Partial<Ix> = {}, match = key()): Ix => ({
      programId: game,
      keys: [k(relayer, true, true), k(assignmentOf(match)), k(), k(match, false, true), k()],
      data: FINALIZE,
      ...over,
    });
    it("is a game exit that costs the relayer the receipt's rent and needs no Player signature", () => {
      expect(plan([fin()])).toMatchObject({ kind: "game", class: "exit", signers: [], playerSigns: false, spend: { refundable: RECEIPT_RENT, sunk: 0n } });
    });
    it("names the Match so the service can require it to exist", () => {
      const f = fin();
      expect(plan([f]).obligations).toEqual([f.keys[3].pubkey]);
    });
    it("is refused when the caller is not first, the relayer appears twice, or anyone else signs", () => {
      const m = key();
      const withKeys = (...ks: ReturnType<typeof k>[]) => fin({ keys: [...ks.slice(0, 1), k(assignmentOf(m)), k(), k(m), ...ks.slice(1)] }, m);
      refused([withKeys(k(key(), true, true))], "bad-signer");
      refused([withKeys(k(relayer, true, true), k(relayer))], "relayer-in-accounts");
      refused([withKeys(k(relayer, true, true), k(key(), true))], "bad-signer");
      refused([withKeys(k(relayer, false, true))], "bad-flags");
    });
    it("is refused when the Assignment is not the Match's own", () => {
      const f = fin();
      refused([{ ...f, keys: [f.keys[0], k(), ...f.keys.slice(2)] }], "bad-accounts");
      refused([fin({ programId: key() })], "unknown-program");
    });
    it("is refused for other instructions, other Games, extra instructions and pile-ups of accounts", () => {
      refused([fin({ data: new Uint8Array([171, 61, 218, 56, 127, 115, 12, 218]) })], "relayer-in-accounts");
      refused([fin({ programId: key() })], "unknown-program");
      refused([fin(), fin()], "relayer-in-accounts");
      refused([fin({ keys: [k(relayer, true, true), ...Array.from({ length: 30 }, () => k())] })], "bad-shape");
      refused([fin({ data: new Uint8Array([...FINALIZE, 1]) })], "relayer-in-accounts");
    });
  });
});
