"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Notice } from "@/components/ui";
import { BlockPuzzleGame, type MatchRun } from "@/games/block-puzzle/BlockPuzzleGame";
import { BlockPuzzleChain, type Seat } from "@/games/block-puzzle/chain";
import { useAccount } from "@/lib/account";
import { commitPendingSince, commitPhase, setCommitPending, type CommitState } from "@/lib/chain/commit-pending";
import { getChain } from "@/lib/chain/client";
import { backerDelta, matchDelta, matchFee, seatResult } from "@/lib/chain/ledger";
import { parseMatchKey } from "@/lib/chain/match-id";
import { canClaimTimeout, runSubmitter, ensureJoined, claimTimeout, prepareRun, probeRun, refundMatch, trySettle } from "@/lib/chain/match-flow";
import { fetchMatch, type ChainMatch } from "@/lib/chain/read";
import type { RunSubmitter } from "@/lib/chain/run-submitter";
import { BackingSplit } from "./BackingSplit";
import { MatchResult } from "./MatchResult";
import { MatchSpectate } from "./MatchSpectate";
import { delayedOf } from "@/lib/chain/match-status";
import { useNowSecs } from "@/lib/chain/useNowSecs";
import { MatchStage, MatchStageLoading, StageAction, type StageKind } from "./MatchStage";
import { Receipts } from "./Receipts";
import { plainError } from "@/lib/errors";

type Phase =
  | "loading"
  | "notfound"
  | "spectator"
  | "queued"
  | "backer-watch"
  | "prep"
  | "ready"
  | "starting"
  | "playing"
  | "submitting"
  | "awaiting"
  | "result";

const errText = plainError;
const SETTLE_TRY_MS = 6000;

/**
 * One Block Burst Match, driven by what is on chain: waiting for an opponent, preparing the
 * private Boards, playing (moves are submitted to the private rollup as you place), waiting for the
 * opponent, then the result. Every step re-reads chain state, so a reload resumes where you were.
 */
export function MatchView({ matchId }: { matchId: string }) {
  const { auth, refresh, snapshot } = useAccount();
  const signer = auth.signer;
  const nowSecs = useNowSecs();
  const id = parseMatchKey(matchId) ? matchId : null;

  const [match, setMatch] = useState<ChainMatch | null>(null);
  const [phase, setPhaseState] = useState<Phase>("loading");
  const [step, setStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<MatchRun | null>(null);
  const [final, setFinal] = useState<{ score: number; moves: number } | null>(null);
  const [sigs, setSigs] = useState<{ label: string; sig: string }[]>([]);
  const [timeoutOk, setTimeoutOk] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [refundable, setRefundable] = useState(false);

  const phaseRef = useRef<Phase>("loading");
  const setPhase = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhaseState(p);
  }, []);
  const working = useRef(false);
  const submitter = useRef<RunSubmitter | null>(null);
  const movesLost = useRef<string | null>(null);
  const lastSettle = useRef(0);
  const settledSeen = useRef(false);
  const commitSince = useRef(0);
  const [commit, setCommit] = useState<CommitState | null>(null);

  const addSig = useCallback((label: string, sig?: string) => {
    if (sig) setSigs((s) => (s.some((x) => x.sig === sig) ? s : [...s, { label, sig }]));
  }, []);

  const markSent = useCallback(() => {
    if (id === null) return;
    commitSince.current ||= Date.now();
    setCommitPending(id, true);
  }, [id]);

  const tick = useCallback(async () => {
    if (!signer || id === null || working.current) return;
    if (["playing", "starting", "submitting"].includes(phaseRef.current)) return;
    working.current = true;
    try {
      const me = BlockPuzzleChain.coreAccount(signer.publicKey);
      const m = await fetchMatch(id, me);
      setMatch(m);
      const now = Date.now() / 1000;
      setRefundable(!!m && (m.status === "open" || !m.session?.joined || delayedOf(m, now)?.refundOpen === true) && now > m.deadline);
      if (!m) return setPhase("notfound");
      if (m.seat === null && m.backerSeat === null) return setPhase("spectator");
      if (m.status === "settled" || m.status === "refunded") {
        if (!settledSeen.current) {
          settledSeen.current = true;
          setCommitPending(m.id, false);
          setCommit(null);
          // A settle race or a retry that failed earlier no longer matters once the Match is final.
          setError(movesLost.current);
          void refresh();
        }
        return setPhase("result");
      }
      // The Backer funds a side without playing it: they watch until the result.
      if (m.seat === null) return setPhase("backer-watch");

      await ensureJoined(signer, m);
      // The opener plays as soon as the Match exists; the joiner plays after joining. Same steps.
      const stage = await probeRun(signer, m, phaseRef.current !== "ready");
      if (stage === "needs-prep") {
        setPhase("prep");
        setError(null);
        await prepareRun(signer, id, m.seat, setStep);
        setMatch(await fetchMatch(id, me));
        return setPhase("ready");
      }
      if (stage === "ready") return setPhase("ready");
      if (stage === "lost-run") {
        // The page was reloaded mid-run: the run cannot be resumed, so close it with what landed.
        await getChain().finish(signer, id, m.seat).catch(() => undefined);
      }
      if (m.status === "open") return setPhase("queued");
      setPhase("awaiting");
      if (await canClaimTimeout(m)) setTimeoutOk(true);
      commitSince.current ||= commitPendingSince(id) ?? 0;
      if (Date.now() - lastSettle.current >= SETTLE_TRY_MS) {
        lastSettle.current = Date.now();
        const r = await trySettle(signer, id, m.session, { sealed: commitSince.current > 0, onSent: markSent });
        if (r.sig) addSig("settle", r.sig);
        if (r.outcome === "settled") setMatch(await fetchMatch(id, me));
        if (r.outcome === "failed") setError(r.error ?? "Couldn’t finish the Match. Try again.");
        if (r.outcome === "commit-pending") markSent();
      }
      if (commitSince.current) {
        const phase = commitPhase(commitSince.current, Date.now());
        setCommit((c) => (c?.phase === phase ? c : { phase, won: false }));
        setError(null);
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      working.current = false;
    }
  }, [signer, id, setPhase, addSig, refresh, markSent]);

  useEffect(() => {
    if (!signer || id === null) return;
    const first = setTimeout(() => void tick(), 0);
    const t = setInterval(() => void tick(), 3000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [signer, id, tick]);

  const begin = async () => {
    if (!signer || id === null || !match || match.seat === null || !match.session) return;
    const seat: Seat = match.seat;
    setError(null);
    setPhase("starting");
    try {
      const startedAt = performance.now();
      const { sig, seed } = await getChain().beginRun(signer, id, seat);
      addSig("begin_run", sig);
      const sub = runSubmitter(signer, id, seat);
      submitter.current = sub;
      setRun({
        seed,
        startedAt,
        entry: match.entry,
        onMove: (mv) => sub.push(mv),
        onEnd: (f) => {
          setFinal(f);
          setPhase("submitting");
          void (async () => {
            await sub.finish();
            if (sub.error) {
              movesLost.current = `Some moves were not accepted: ${errText(sub.error)}`;
              setError(movesLost.current);
            }
            setRun(null);
            lastSettle.current = 0;
            setPhase("awaiting");
          })();
        },
      });
      setPhase("playing");
    } catch (e) {
      setError(errText(e));
      setPhase("ready");
    }
  };

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await fn();
      lastSettle.current = 0;
      working.current = false;
      await tick();
      void refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  if (id === null) return <Notice title="Match not found" body="That Match id is not valid." />;
  if (auth.status === "signed-out") return <MatchSpectate matchId={matchId} onSignIn={() => auth.openSignIn("Enter a Match")} />;
  if (!signer) return <MatchStageLoading game="block-puzzle" me={snapshot?.accountKey.toBase58() ?? null} step="Getting your wallet ready" />;
  if (phase === "loading") return <MatchStageLoading game="block-puzzle" me={snapshot?.accountKey.toBase58() ?? null} />;
  if (phase === "notfound") return <Notice title="Match not found" body="This Match doesn’t exist, or the link is incomplete." />;
  if (phase === "spectator") return <MatchSpectate matchId={matchId} />;

  if (phase === "playing" && run) {
    return (
      <div className="stack">
        <BlockPuzzleGame
          run={run}
          matchPanel={
            <div className="bpx-status" role="status">
              <p>{match?.status === "open" ? "Your opponent gets the same pieces · waiting to be paired" : "Your opponent gets the same pieces · higher score wins"}</p>
              {match?.status === "open" && (
                <span className="bpx-finding">
                  <i className="bpx-spin" aria-hidden="true" /> Finding opponent…
                </span>
              )}
              {error && <p className="status err" role="alert">{error}</p>}
            </div>
          }
        />
      </div>
    );
  }

  const m = match;
  const link = typeof window === "undefined" || !m ? "" : `${window.location.origin}/play/challenge/${m.id.toString()}`;
  const session = m?.session;
  const mineIdx = m?.seat ?? m?.backerSeat ?? 0;
  const asBacker = !!m && m.seat === null && m.backerSeat !== null;
  const playerBacked = !!m && m.seat !== null && m.backing !== null;
  const scores = session ? [session.scores[mineIdx], session.scores[1 - mineIdx]] : null;
  const delta = !m ? 0 : asBacker && m.backing ? backerDelta({ ...m, backerSeat: m.backing.seat, shareBps: m.backing.shareBps }) : matchDelta(m);
  const outcome = !m || m.status === "open" || m.status === "active" ? null : !session || !session.settled ? "refunded" : session.result === "draw" ? "draw" : seatResult(m, mineIdx) === "won" ? "won" : "lost";

  if (phase === "result" && m && outcome) {
    return (
      <MatchResult
        game="block-puzzle"
        outcome={outcome}
        delta={delta}
        entry={m.entry}
        fee={Number(fmtFee(m))}
        role={asBacker ? "backer" : "player"}
        backed={!!m.backing}
        scores={scores && outcome !== "refunded" ? [String(scores[0]), String(scores[1])] : null}
        momentKey={m.id.toString()}
        matchId={m.id.toString()}
        playAgainHref={`/play/queue?entry=${m.entry}`}
        opponent={m.opponent}
        split={m.backing ? <BackingSplit m={m} /> : undefined}
      >
        {error && <p className="status err" role="alert">{error}</p>}
        <Receipts items={sigs} />
        <p className="note">Test mode · Gemas come from simulated yield and have no real value.</p>
      </MatchResult>
    );
  }

  const kind: StageKind | null =
    phase === "backer-watch"
      ? "backer-watch"
      : phase === "queued"
        ? "waiting-run"
        : phase === "prep"
          ? "setup"
          : phase === "ready" || phase === "starting"
            ? "ready"
            : phase === "submitting"
              ? "saving-run"
              : phase === "awaiting"
                ? commit
                  ? "closing"
                  : "awaiting"
                : null;
  if (!kind || !m) return <MatchStageLoading game="block-puzzle" me={snapshot?.accountKey.toBase58() ?? null} />;
  const refund = () => act("refund", async () => addSig("refund", await refundMatch(signer, m.id)));

  return (
    <MatchStage
      game="block-puzzle"
      kind={kind}
      entry={m.entry}
      pot={m.entry * 2 - matchFee(m)}
      me={asBacker ? (m.backing?.player ?? null) : (snapshot?.accountKey.toBase58() ?? null)}
      opponent={m.opponent}
      score={final?.score ?? null}
      step={kind === "setup" ? step || "Creating your session" : kind === "saving-run" ? "Saving your last moves" : undefined}
      deadline={m.deadline || undefined}
      challengeLink={m.challenge && kind === "waiting-run" ? link : null}
      backedShareBps={playerBacked && m.backing ? m.backing.shareBps : null}
      commit={commit}
      delayed={delayedOf(m, nowSecs)}
      error={error}
      start={
        kind === "ready" && (
          <Button variant="money" size="lg" block disabled={phase === "starting"} onClick={begin}>
            {phase === "starting" ? "Starting…" : "Start · 90 s"}
          </Button>
        )
      }
      actions={
        <>
          {kind === "waiting-run" && (
            <StageAction disabled={busy !== null} onClick={refund}>
              {busy === "refund" ? "Refunding…" : playerBacked ? "Cancel (Gemas return to your Backer)" : "Cancel and refund"}
            </StageAction>
          )}
          {kind === "awaiting" && (
            <StageAction
              disabled={busy !== null}
              onClick={() =>
                act("settle", async () => {
                  const r = await trySettle(signer, m.id, undefined, { sealed: commitSince.current > 0, onSent: markSent });
                  if (r.sig) addSig("settle", r.sig);
                  if (r.outcome === "waiting-opponent") setError("Your opponent is still playing.");
                  if (r.outcome === "failed") setError(r.error ?? "Couldn’t finish the Match. Try again.");
                })
              }
            >
              {busy === "settle" ? "Checking…" : "Check now"}
            </StageAction>
          )}
          {kind === "awaiting" && timeoutOk && (
            <StageAction disabled={busy !== null} onClick={() => act("timeout", async () => addSig("claim_timeout", await claimTimeout(signer, m.id)))}>
              Time’s up: refund both entries
            </StageAction>
          )}
          {refundable && (kind === "awaiting" || kind === "closing" || kind === "ready" || kind === "setup") && (
            <StageAction disabled={busy !== null} onClick={refund}>
              Refund Match
            </StageAction>
          )}
        </>
      }
    >
      <Receipts items={sigs} />
      <p className="note">Test mode · Gemas come from simulated yield and have no real value.</p>
    </MatchStage>
  );
}

function fmtFee(m: ChainMatch): string {
  return String(matchFee(m));
}

