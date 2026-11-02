import { PublicKey, type AddressLookupTableAccount, type TransactionInstruction } from "@solana/web3.js";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import { getChain } from "./client";
import type { GetToken } from "./demo-client";
import { finalizeAndFinish, finishMatch, type FinishDeps, type FinishResult, type Planned, type Progress } from "./finish-match";
import {
  CHUNK_STEPS,
  CHUNK_UNITS,
  closeIx,
  compileTx,
  connReader,
  fits,
  loadMatch,
  missingCutPages,
  planSizedChunk,
  runOf,
  sourcesAhead,
  viewOf,
  type MatchView,
} from "./settle-plan";
import { SponsorError, sponsorStatus, sponsoredSend } from "./sponsor-client";

/** Compute limit the sponsor server puts on a chunk or a close (rules.ts `match_chunk` / `close_match`). */
const CLOSE_UNITS = 300_000;

const progressOf = (v: MatchView): Progress => {
  const run = runOf(v.inner.run);
  return { stage: v.stage, phase: run?.phaseI ?? 0, line: run?.lineI ?? 0 };
};

/**
 * The steps that finish a Match, sent through the relayer so the Player's wallet pays nothing. Null when free
 * transactions are paused or empty: the keeper's safety sweep finishes the Match then, the Gemas are not at risk.
 */
async function sponsoredDeps(signer: ChainSigner, getToken: GetToken): Promise<FinishDeps | null> {
  if (!signer.signSerialized) return null;
  const status = await sponsorStatus();
  if (status.paused) return null;
  const core = getChain().core as unknown as Parameters<typeof closeIx>[0];
  const conn = getChain().base;
  const relayer = new PublicKey(status.relayer);
  const read = connReader(conn);
  const tables = (await Promise.all((status.tables ?? []).map((t) => conn.getAddressLookupTable(new PublicKey(t)).then((r) => r.value)))).filter((t): t is AddressLookupTableAccount => !!t);
  const views = new Map<string, MatchView>();

  return {
    fetch: async (address) => {
      const account = await getChain().core.account.matchState.fetchNullable(address);
      if (!account) return null;
      const view = viewOf(address, account);
      views.set(address.toBase58(), view);
      return progressOf(view);
    },
    plan: async (_progress, address): Promise<Planned> => {
      const view = views.get(address.toBase58());
      if (!view) return { kind: "stalled", reason: "unread" };
      const loaded = await loadMatch(read, view);
      if (view.stage === "closed") return { kind: "close", ix: await closeIx(core, read, relayer, loaded) };
      const run = runOf(view.inner.run);
      if (!loaded.stores[0] || !run) return { kind: "stalled", reason: "no-run" };
      if ((await missingCutPages(read, sourcesAhead(run, loaded.stores, CHUNK_STEPS))).length) return { kind: "stalled", reason: "needs-page" };
      const opts = { units: CHUNK_UNITS, tables };
      const plan = await planSizedChunk(
        {
          core,
          read,
          caller: relayer,
          fitsOne: (ix) => fits(relayer, [ix], opts),
          simulate: async (ix: TransactionInstruction) => {
            try {
              const { blockhash } = await conn.getLatestBlockhash();
              const res = (await conn.simulateTransaction(compileTx(relayer, blockhash, [ix], opts), { sigVerify: false })).value;
              return res.unitsConsumed ?? null;
            } catch {
              return null;
            }
          },
        },
        loaded,
      );
      if (!plan) return { kind: "stalled", reason: "no-run" };
      if (plan.missing.length) return { kind: "stalled", reason: "missing-book" };
      return { kind: "chunk", ix: plan.ix };
    },
    send: (step) => sponsoredSend(signer, getToken, [step.ix]),
  };
}

const NOT_SENT: FinishResult = { done: false, stalled: "sponsor-unavailable", signatures: [] };

/** Runs a Game's `finalize`, then chunks and `close_match` until the Match is closed, sponsored. Idempotent: any Player's page can call it, in any order. */
export async function finalizeAndFinishFree(signer: ChainSigner, getToken: GetToken, address: PublicKey, finalize: () => Promise<string | null | undefined>): Promise<FinishResult> {
  const deps = await sponsoredDeps(signer, getToken).catch(selfPayToNull);
  if (!deps) {
    await finalize();
    return NOT_SENT;
  }
  return finalizeAndFinish(deps, address, finalize);
}

/** Chunks and `close_match` for a Match whose `finalize` already landed (the page found it Settling or Closed). */
export async function finishMatchFree(signer: ChainSigner, getToken: GetToken, address: PublicKey): Promise<FinishResult> {
  const deps = await sponsoredDeps(signer, getToken).catch(selfPayToNull);
  return deps ? finishMatch(deps, address) : NOT_SENT;
}

/** Free transactions that cannot be used right now are not an error for finishing: the sweep does it. */
function selfPayToNull(e: unknown): null {
  if (e instanceof SponsorError && e.selfPay) return null;
  throw e;
}
