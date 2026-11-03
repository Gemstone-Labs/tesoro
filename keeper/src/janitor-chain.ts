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

function assignmentSource(label: string, program: { programId: PublicKey; idl: any }, rpc: ScanRpc, close: (m: PublicKey) => Promise<string>): AssignmentSource {
  const disc: number[] = program.idl.accounts.find((a: { name: string }) => a.name === "Assignment").discriminator;
  return {
    label,
    matches: async () => {
      const rows = await scanProgramAccounts(rpc, program.programId, { filters: [{ memcmp: { offset: 0, bytes: bs58.encode(Buffer.from(disc)) } }], dataSlice: { offset: MATCH_AT, length: 32 } });
      return rows.map((r) => new PublicKey(r.account.data));
    },
    close,
  };
}

export function realJanitorDeps(ctx: Ctx): JanitorDeps {
  const gpa = new Connection(ctx.settings.gpaRpc, { commitment: "confirmed", fetch: solanaFetch, disableRetryOnRateLimit: true });
  const rpc = makeScanRpc(ctx.settings.gpaRpc, solanaFetch, (p, c) => gpa.getProgramAccounts(p, c as any) as any);
  const chains: Record<string, { programId: PublicKey; idl: any }> = {
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
