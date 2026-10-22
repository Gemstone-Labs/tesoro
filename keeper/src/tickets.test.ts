import assert from "node:assert/strict";
import { describe, it } from "node:test";
import anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { Budget, type Ctx } from "./act.ts";
import { accountBytes, bookBytes, chainOf, ixNameOf, ticketBytes } from "./fixtures.ts";
import { bookOf, decodeTicketHead } from "./kit.ts";
import { loadIdl } from "./runtime.ts";
import { offerOfBackingTicket, planTickets, ticketJob, type TicketDeps, type TicketRow } from "./tickets.ts";
import type { Info } from "./supply.ts";

const core = new anchor.Program(loadIdl("tesoro_core"), new anchor.AnchorProvider(new Connection("http://127.0.0.1:1"), new anchor.Wallet(Keypair.generate()), {}));
const k = () => Keypair.generate().publicKey;
const NOW = 1_800_000_000;
const row = (state: number, expiresAt: number, kind = 0, account = k()): TicketRow => ({ address: k(), head: decodeTicketHead(ticketBytes({ state, expiresAt, kind, account })) });

describe("Ticket upkeep plan", () => {
  it("cancels expired Open Tickets, goes on with half cancelled ones and closes Cancelled ones", () => {
    const rows = [row(0, NOW - 1), row(0, NOW + 100), row(1, NOW + 100), row(3, 0), row(2, 0)];
    assert.deepEqual(planTickets(rows, NOW).map((a) => a.kind), ["cancel", "cancel", "close"]);
    assert.equal(planTickets(rows, NOW)[0].row, rows[0]);
  });
  it("leaves a Ticket that became a Pot alone", () => {
    assert.deepEqual(planTickets([row(2, NOW - 5000)], NOW), []);
  });
});

describe("the Offer of a Backing Ticket", () => {
  it("is the Backer's Offer for the same Game and amount with its Ticket open", async () => {
    const [backer, game] = [k(), k()];
    const mk = async (over: object) => ({ publicKey: k(), account: core.coder.accounts.decode("offerState", await accountBytes(core, "OfferState", { inner: { backer: backer.toBytes(), game: game.toBytes(), entry: new anchor.BN(500), ticketOpen: true, ...over } })) });
    const right = await mk({});
    const offers = [await mk({ ticketOpen: false }), await mk({ entry: new anchor.BN(900) }), right];
    const head = decodeTicketHead(ticketBytes({ kind: 1, account: backer, game, target: 500n }));
    assert.equal(offerOfBackingTicket(offers, head)!.toBase58(), right.publicKey.toBase58());
    assert.equal(offerOfBackingTicket([], head), null);
  });
});

describe("the Ticket job", () => {
  const payer = Keypair.generate();
  const ctxOf = (dryRun = false): Ctx => ({ core: chainOf(core, new Map()), conn: { getBalance: async () => 1e9 }, payer, now: NOW, settings: { dryRun }, budget: new Budget(1e15), lz: new Budget(1e15) }) as unknown as Ctx;

  function deps(tickets: Map<string, Buffer>, books: Map<string, Buffer> = new Map(), steps: Map<string, Buffer[]> = new Map()) {
    const sent: string[] = [];
    const d: TicketDeps = {
      list: async () => [...tickets].map(([a, data]) => ({ pubkey: new PublicKey(a), data })),
      read: { async many(keys) { return keys.map((x) => { const v = tickets.get(x.toBase58()) ?? books.get(x.toBase58()); return v ? ({ data: v } as Info) : null; }); } },
      send: async (ixs) => {
        const name = ixs.map((i) => ixNameOf(core, i)).join("+");
        sent.push(name);
        // a cancel moves the Ticket to its next scripted state
        for (const [addr, next] of steps) if (name === "cancelTicket" && next.length) tickets.set(addr, next.shift()!);
        return `sig${sent.length}`;
      },
      offers: async () => [],
    };
    return { d, sent };
  }

  it("cancels an expired Entry Ticket until it is Cancelled, then closes it", async () => {
    const owner = k();
    const source = k();
    const t = k();
    const tickets = new Map<string, Buffer>([[t.toBase58(), ticketBytes({ state: 0, expiresAt: NOW - 10, account: owner }, [{ source, amount: 5n }])]]);
    const books = new Map<string, Buffer>([[bookOf(source).toBase58(), bookBytes([0, 0, 0, 0])]]);
    const steps = new Map<string, Buffer[]>([[t.toBase58(), [ticketBytes({ state: 1, expiresAt: NOW - 10, account: owner }, [{ source, amount: 2n }]), ticketBytes({ state: 3, account: owner })]]]);
    const { d, sent } = deps(tickets, books, steps);
    await ticketJob(ctxOf(), d);
    assert.deepEqual(sent, ["cancelTicket", "cancelTicket", "closeTicket"]);
  });

  it("does nothing for Tickets still running, and in dry-run sends nothing", async () => {
    const tickets = new Map<string, Buffer>([[k().toBase58(), ticketBytes({ state: 0, expiresAt: NOW + 100, account: k() })]]);
    const idle = deps(tickets);
    assert.equal(await ticketJob(ctxOf(), idle.d), 0);
    const late = new Map<string, Buffer>([[k().toBase58(), ticketBytes({ state: 3, account: k() })]]);
    const dry = deps(late);
    await ticketJob(ctxOf(true), dry.d);
    assert.deepEqual([idle.sent, dry.sent], [[], []], "a dry run reports what it would do and sends nothing");
  });
});
