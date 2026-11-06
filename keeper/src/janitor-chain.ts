import anchor from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import type { Ctx } from "./act.ts";
import { makeScanRpc, scanProgramAccounts, type ScanRpc } from "./credits.ts";
import type { AssignmentSource, JanitorDeps } from "./janitor.ts";
import { CORE_ID, programDataOf } from "./kit.ts";
import { discriminatorOf, type Lister } from "./lists.ts";
import { solanaFetch } from "./runtime.ts";
import { ADAPTERS } from "./scheduler-games.ts";
import { sendIxs } from "./send.ts";
import { connReader } from "./supply.ts";
import { simulate } from "./tee.ts";

const bs58 = anchor.utils.bytes.bs58;

/** A Lister over `getProgramAccountsV2` (paginated, sliced) for tesoro_core accounts of one type. */
export const v2Lister = (rpc: ScanRpc): Lister => async (account, opts = {}) => {
  const filters: ({ memcmp: { offset: number; bytes: string } } | { dataSize: number })[] = [{ memcmp: { offset: 0, bytes: bs58.encode(discriminatorOf(account)) } }];
  if (opts.dataSize) filters.push({ dataSize: opts.dataSize });
  const rows = await scanProgramAccounts(rpc, CORE_ID, { filters, dataSlice: opts.dataSlice });
  return rows.map((r) => ({ pubkey: r.pubkey, data: Buffer.from(r.account.data) }));
};

/** Where the Assignment account's `tesoro_match` sits: after the discriminator and the bump. */
const MATCH_AT = 8 + 1;

/** Anchor camel-cases account names once a program is loaded, so the IDL names it "assignment". */
export function assignmentDiscriminator(program: { idl: any }): number[] {
  const found = program.idl.accounts.find((a: { name: string }) => a.name.toLowerCase() === "assignment");
  if (!found) throw new Error("the Game's IDL has no Assignment account");
  return found.discriminator;
}

/**
 * Bytes of an Assignment in the Game's current layout. Assignments of an older layout (from before seat keys) decode neither in
 * the client nor in the program, so `close_assignment` can never close them; the scan leaves them out.
 */
export function assignmentSize(program: { idl: any; coder: any }): number {
  const found = program.idl.accounts.find((a: { name: string }) => a.name.toLowerCase() === "assignment");
  if (!found) throw new Error("the Game's IDL has no Assignment account");
  return program.coder.accounts.size(found.name);
}

export function assignmentSource(label: string, program: { programId: PublicKey; idl: any; coder: any }, rpc: ScanRpc, close: (m: PublicKey) => Promise<string>): AssignmentSource {
  const disc = assignmentDiscriminator(program);
  const size = assignmentSize(program);
  return {
    label,
    matches: async () => {
      const filters = [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(disc)) } }, { dataSize: size }];
      const rows = await scanProgramAccounts(rpc, program.programId, { filters, dataSlice: { offset: MATCH_AT, length: 32 } });
      return rows.map((r) => new PublicKey(r.account.data));
    },
    close,
  };
}

export function realJanitorDeps(ctx: Ctx): JanitorDeps {
  const gpa = new Connection(ctx.settings.gpaRpc, { commitment: "confirmed", fetch: solanaFetch, disableRetryOnRateLimit: true });
  const rpc = makeScanRpc(ctx.settings.gpaRpc, solanaFetch, (p, c) => gpa.getProgramAccounts(p, c as any) as any);
  const chains: Record<string, { programId: PublicKey; idl: any; coder: any }> = {
    "trading-duel": (ctx.duel as any).program,
    holdem: (ctx.holdem as any).program,
    "block-burst": (ctx.burst as any).program,
    vanguard: (ctx.vanguard as any).program,
  };
  return {
    list: v2Lister(rpc),
    read: connReader(ctx.conn),
    send: (ixs, opts) => sendIxs(ctx.conn, ctx.payer, ixs, opts),
    simulate: (ixs) => simulate(ctx.conn, ctx.payer, ixs),
    offers: async () => {
      const rows = await scanProgramAccounts(rpc, CORE_ID, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(discriminatorOf("OfferState")) } }] });
      return rows.map((r) => ({ publicKey: r.pubkey, account: ctx.core.coder.accounts.decode("offerState", r.account.data) }));
    },
    assignments: ADAPTERS.map((a) => assignmentSource(a.label, chains[a.label], rpc, (m) => a.closeAssignment(ctx, m))),
    deploySlots: async (games) =>
      Promise.all(
        games.map(async (g) => {
          const info = await ctx.conn.getAccountInfo(programDataOf(g), { dataSlice: { offset: 4, length: 8 } });
          return info ? info.data.readBigUInt64LE(0) : null;
        }),
      ),
    publishApy: null,
  };
}
