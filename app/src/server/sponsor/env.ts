import "server-only";
import { createHash } from "node:crypto";
import { BorshAccountsCoder, type Idl } from "@coral-xyz/anchor";
import { AddressLookupTableAccount, Connection, Keypair, PublicKey } from "@solana/web3.js";
import coreIdl from "@/lib/chain/idl/tesoro_core.json";
import { gameRecordPda, programDataPda } from "@/lib/chain/game-record";
import { BRAND } from "@/lib/brand";
import { BASE_RPC, relayerKey } from "../demo-advance";
import { alertRecipients } from "../notify/routes";
import { senderFromEnv } from "../notify/sender";
import { DemoHttpError } from "../request-auth";
import { DEFAULT_LIMITS, type Limits } from "./policy";
import { CORE_ID } from "./rules";
import { Sponsor, type ChainReads } from "./service";
import { inviteKeypair } from "../invite/key";
import { supabaseInviteStore } from "../invite/supabase-store";
import { MemoryUsageStore, type UsageStore } from "./store";
import { supabaseUsageStore } from "./supabase-store";
import { sendConfirmed } from "./chain-send";

const LAMPORTS = 1_000_000_000n;
const coder = new BorshAccountsCoder(coreIdl as unknown as Idl);
const sponsorPda = PublicKey.findProgramAddressSync([Buffer.from("sponsor")], CORE_ID)[0];

function chainReads(conn: Connection): ChainReads {
  return {
    balance: async (k) => BigInt(await conn.getBalance(k, "confirmed")),
    rent: async (bytes) => BigInt(await conn.getMinimumBalanceForRentExemption(bytes, "confirmed")),
    account: async (k) => {
      const a = await conn.getAccountInfo(k, "confirmed");
      return a ? { owner: a.owner, data: a.data } : null;
    },
    latestBlockhash: async () => (await conn.getLatestBlockhash("confirmed")).blockhash,
    send: (raw) => sendConfirmed(conn, raw),
  };
}

/** Limits from TESORO_SPONSOR_LIMITS (JSON, only the fields to change; lamport fields as strings). */
function limitsFromEnv(raw = process.env.TESORO_SPONSOR_LIMITS): Limits {
  if (!raw) return DEFAULT_LIMITS;
  const o = JSON.parse(raw) as Record<string, number | string>;
  const out: Record<string, unknown> = { ...DEFAULT_LIMITS };
  for (const [k, v] of Object.entries(o)) {
    if (!(k in DEFAULT_LIMITS)) throw new Error(`TESORO_SPONSOR_LIMITS: unknown field ${k}`);
    out[k] = typeof (DEFAULT_LIMITS as unknown as Record<string, unknown>)[k] === "bigint" ? BigInt(v) : Number(v);
  }
  return out as unknown as Limits;
}

const ttl = <T,>(ms: number, f: () => Promise<T>) => {
  let at = 0;
  let v: T;
  return async () => {
    if (Date.now() - at > ms) {
      v = await f();
      at = Date.now();
    }
    return v;
  };
};

let instance: Sponsor | null = null;

/** The production wiring: the relayer key, the RPC, Postgres counters, Resend for the low-balance email. */
export function sponsor(): Sponsor {
  if (instance) return instance;
  const relayer = relayerKey();
  const conn = new Connection(BASE_RPC, "confirmed");
  const chain = chainReads(conn);
  const store: UsageStore = process.env.SUPABASE_URL ? supabaseUsageStore : process.env.NODE_ENV === "production" ? failClosed() : new MemoryUsageStore();
  const macKey = process.env.TESORO_SPONSOR_MAC_SECRET
    ? Buffer.from(process.env.TESORO_SPONSOR_MAC_SECRET)
    : createHash("sha256").update(relayer.secretKey).update("tesoro-sponsor-mac-v1").digest();
  const tables = (process.env.TESORO_SPONSOR_LOOKUP_TABLES ?? "").split(",").map((s) => s.trim()).filter(Boolean).map((s) => new PublicKey(s));
  const lookupTables = ttl(5 * 60_000, async () => {
    const got = await Promise.all(tables.map((t) => conn.getAddressLookupTable(t).then((r) => r.value)));
    return got.filter((t): t is AddressLookupTableAccount => !!t);
  });
  const onChainPaused = ttl(15_000, async () => {
    const a = await chain.account(sponsorPda);
    if (!a) return true;
    const s = coder.decode("SponsorState", Buffer.from(a.data)) as { relayer: PublicKey; paused: boolean };
    return s.paused || !s.relayer.equals(relayer.publicKey);
  });
  instance = new Sponsor({
    relayer,
    macKey,
    store,
    limits: limitsFromEnv(),
    chain,
    isListed: async (program) => {
      const [record, data] = await Promise.all([chain.account(gameRecordPda(program)), chain.account(programDataPda(program))]);
      if (!record || !data || !record.owner.equals(CORE_ID) || data.data.length < 12) return false;
      const g = coder.decode("GameRecord", Buffer.from(record.data)) as { listedUntil: { toString(): string }; approvedSlot: { toString(): string } };
      const slot = Buffer.from(data.data).readBigUInt64LE(4);
      return BigInt(g.listedUntil.toString()) > BigInt(Math.floor(Date.now() / 1000)) && BigInt(g.approvedSlot.toString()) === slot;
    },
    lookupTables,
    paused: async () => process.env.TESORO_SPONSOR_PAUSED === "1" || (await onChainPaused()),
    lowBalance: BigInt(Math.round(Number(process.env.TESORO_SPONSOR_LOW_SOL ?? "2") * 1e9)),
    alertLowBalance: async (balance) => {
      const sender = senderFromEnv();
      const to = alertRecipients(process.env.ALERT_EMAILS);
      if (!sender || !to.length) throw new Error("no sender or ALERT_EMAILS for the low-balance email");
      const sol = Number(balance) / Number(LAMPORTS);
      await Promise.all(to.map((addr) => sender.send({ to: addr, subject: `[${BRAND.name} alert] Relayer balance is low`, text: `The relayer ${relayer.publicKey.toBase58()} holds ${sol.toFixed(3)} SOL. Free transactions stop for new entries when the balance reaches the floor plus what is held for finishing Matches. Top it up.` })));
    },
    // A sponsored new Account while the Invite gate is on is co-signed with the Invite key, for a wallet that redeemed an Invite.
    invite: inviteFromEnv(),
    alertOnboarding: async (used, max) => {
      const sender = senderFromEnv();
      const to = alertRecipients(process.env.ALERT_EMAILS);
      if (!sender || !to.length) throw new Error("no sender or ALERT_EMAILS for the onboarding email");
      await Promise.all(to.map((addr) => sender.send({ to: addr, subject: `[${BRAND.name} alert] Free new Accounts are filling up`, text: `${used} of today's ${max} free new Accounts are used. Past ${max} new Players pay for their own Account until tomorrow. Raise TESORO_SPONSOR_LIMITS onboardPerDay if this is real traffic, or look for abuse.` })));
    },
    now: () => Date.now(),
  });
  return instance;
}

function inviteFromEnv(): { key: Keypair; redeemed(authority: string): Promise<boolean> } | undefined {
  if (!process.env.INVITE_SECRET_KEY) return undefined;
  return { key: inviteKeypair(process.env.INVITE_SECRET_KEY), redeemed: (authority) => supabaseInviteStore.redeemedBy(authority) };
}

/** No shared counters in production means no limits: refuse everything rather than sponsor without them. */
function failClosed(): UsageStore {
  const refuse = async () => {
    throw new DemoHttpError(503, "not-configured", "Free transactions are not configured on this server.");
  };
  return { take: refuse, refund: refuse, add: refuse, used: refuse, hold: refuse, release: refuse, held: refuse } as UsageStore;
}
