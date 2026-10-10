"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Busy, Button, Card, Chip, GemaAmount, Label, Notice } from "@/components/ui";
import { BlockPuzzleGame, type MatchRun } from "@/games/block-puzzle/BlockPuzzleGame";
import { BlockPuzzleChain, type Seat } from "@/games/block-puzzle/chain";
import { useAccount } from "@/lib/account";
import { getChain } from "@/lib/chain/client";
import { backerDelta, matchDelta, seatResult } from "@/lib/chain/ledger";
import { canClaimTimeout, runSubmitter, ensureJoined, claimTimeout, prepareRun, probeRun, refundMatch, trySettle } from "@/lib/chain/match-flow";
import { fetchMatch, type ChainMatch } from "@/lib/chain/read";
import type { RunSubmitter } from "@/lib/chain/run-submitter";
import { fmtGemas } from "@/lib/format";
import { BackingSplit } from "./BackingSplit";
import { MatchResult } from "./MatchResult";
import { MatchSpectate } from "./MatchSpectate";
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
 * One Block Puzzle Match, driven by what is on chain: waiting for an opponent, preparing the
 * private Boards, playing (moves are submitted to the private rollup as you place), waiting for the
 * opponent, then the result. Every step re-reads chain state, so a reload resumes where you were.
 */
export function MatchView({ matchId }: { matchId: string }) {
  const { auth, refresh } = useAccount();
  const signer = auth.signer;
  const id = (() => {
    try {
      return BigInt(matchId);
    } catch {
      return null;
    }
  })();

  const [match, setMatch] = useState<ChainMatch | null>(null);
  const [phase, setPhaseState] = useState<Phase>("loading");
  const [step, setStep] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<MatchRun | null>(null);
  const [final, setFinal] = useState<{ score: number; moves: number } | null>(null);
  const [sigs, setSigs] = useState<{ label: string; sig: string }[]>([]);
  const [timeoutOk, setTimeoutOk] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
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

  const addSig = useCallback((label: string, sig?: string) => {
    if (sig) setSigs((s) => (s.some((x) => x.sig === sig) ? s : [...s, { label, sig }]));
  }, []);

  const tick = useCallback(async () => {
    if (!signer || id === null || working.current) return;
    if (["playing", "starting", "submitting"].includes(phaseRef.current)) return;
    working.current = true;
    try {
      const me = BlockPuzzleChain.coreAccount(signer.publicKey);
      const m = await fetchMatch(id, me);
      setMatch(m);
      const now = Date.now() / 1000;
      setRefundable(!!m && (m.status === "open" || !m.session?.joined) && now > m.deadline);
      if (!m) return setPhase("notfound");
      if (m.seat === null && m.backerSeat === null) return setPhase("spectator");
      if (m.status === "settled" || m.status === "refunded") {
        if (!settledSeen.current) {
          settledSeen.current = true;
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
      if (Date.now() - lastSettle.current >= SETTLE_TRY_MS) {
        lastSettle.current = Date.now();
        const r = await trySettle(signer, id, m.session);
        if (r.sig) addSig("settle", r.sig);
        if (r.outcome === "settled") setMatch(await fetchMatch(id, me));
        if (r.outcome === "failed") setError(r.error ?? "Couldn’t finish the Match. Try again.");
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      working.current = false;
    }
  }, [signer, id, setPhase, addSig, refresh]);

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
  if (!signer) return <Notice title="Match" body="Getting your wallet ready…" />;
  if (phase === "loading") return <Notice title="Match" body="Loading the Match…" />;
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
            </div>
          }
        />
        {error && <p className="status err" role="alert">{error}</p>}
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
        playAgainHref={`/play/queue?entry=${m.entry}`}
        split={m.backing ? <BackingSplit m={m} /> : undefined}
      >
        {error && <p className="status err" role="alert">{error}</p>}
        <Receipts items={sigs} />
        <p className="note">Test mode · Gemas come from simulated yield and have no real value.</p>
      </MatchResult>
    );
  }

  return (
    <div className="stack-lg" style={{ maxWidth: 480, margin: "0 auto" }}>
      <div className="spread">
        <h1 className="page-title">{asBacker ? "Match you funded" : "Block Puzzle Match"}</h1>
        {m && (
          <Chip tone="money">
            <GemaAmount value={m.entry} size="sm" /> entry
          </Chip>
        )}
      </div>

      {phase === "backer-watch" && m && (
        <Card large>
          <div className="stack">
            <Label>{m.status === "open" ? "Your Player is waiting for an opponent" : "Your Player is in the Match"}</Label>
            <p className="meta">
              Your {fmtGemas(m.entry)} Gemas are in the Pot. You cannot play or steer this Match; the result settles on chain. If your
              Player wins, your entry returns first and the surplus is split by your Offer. If they lose, you bear the loss.
            </p>
            <Busy>Checking every few seconds…</Busy>
          </div>
        </Card>
      )}

      {phase === "queued" && m && (
        <Card large>
          <div className="stack">
            <Label>Your run is in · waiting to be paired</Label>
            {final && <span className="bp-final tnum">{final.score}</span>}
            <p className="meta">
              {playerBacked
                ? `Your Backer's ${fmtGemas(m.entry)} Gemas are held in escrow as your entry,`
                : `Your entry of ${fmtGemas(m.entry)} Gemas is held in escrow,`}{" "}
              and your run is hidden in the private rollup.
              The next Player to join plays the same Seed against your score; nobody sees your moves until both runs are
              closed. If nobody joins before {m.deadline ? new Date(m.deadline * 1000).toLocaleTimeString() : "the Queue window ends"}, the entry is refunded.
              Keep this page open, or come back from the Lobby.
            </p>
            {m.challenge && (
              <div className="stack">
                <Label>Challenge link</Label>
                <code className="mono" style={{ wordBreak: "break-all", fontSize: 12 }}>{link}</code>
                <Button
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(link).then(() => setCopied(true));
                  }}
                >
                  {copied ? "Copied" : "Copy link"}
                </Button>
                <p className="note">Whoever opens this link joins with the same entry. Send it to the person you want to play.</p>
              </div>
            )}
            <Button disabled={busy !== null} onClick={() => act("refund", async () => addSig("refund", await refundMatch(signer, m.id)))}>
              {busy === "refund" ? "Refunding…" : playerBacked ? "Cancel (Gemas return to your Backer)" : "Cancel and refund entry"}
            </Button>
          </div>
        </Card>
      )}

      {phase === "prep" && (
        <Card large>
          <div className="stack">
            <Label>Getting your run ready</Label>
            <Busy>{step || "Creating your session"}…</Busy>
            <p className="note">Your pieces are drawn in secret, so nobody (not even us) can see them before you press Start. About 20 seconds.</p>
          </div>
        </Card>
      )}

      {(phase === "ready" || phase === "starting") && m && (
        <Card large>
          <div className="stack">
            <Label>Ready</Label>
            <p className="meta">
              You and your opponent get the same pieces, 90 seconds each, one after the other. The pieces stay hidden until
              you press Start, and that is when your clock starts.{" "}
              {m.status === "open"
                ? "No opponent yet: play now and you will be paired with the next Player."
                : playerBacked && m.backing
                  ? `Higher score wins: your Backer's entry returns first, then you keep ${m.backing.shareBps / 100}% of the surplus. A loss costs you nothing.`
                  : `Higher score wins ${fmtGemas(m.entry * 2 - Number(fmtFee(m)))} Gemas.`}
            </p>
            <Button variant="money" block disabled={phase === "starting"} onClick={begin}>
              {phase === "starting" ? "Starting…" : "Start run · 90 s"}
            </Button>
          </div>
        </Card>
      )}

      {phase === "submitting" && (
        <Card large>
          <div className="stack">
            <Label>Run over</Label>
            {final && <span className="bp-final tnum">{final.score}</span>}
            <Busy>Saving your last moves…</Busy>
          </div>
        </Card>
      )}

      {phase === "awaiting" && m && (
        <Card large>
          <div className="stack">
            <Label>Waiting for the opponent</Label>
            {final && <span className="bp-final tnum">{final.score}</span>}
            <p className="meta">
              Your score is saved and hidden from your opponent. When they finish (or their time runs out), both scores are
              revealed and the winner is paid.
            </p>
            <Busy>Checking every few seconds…</Busy>
            <Button
              disabled={busy !== null}
              onClick={() =>
                act("settle", async () => {
                  const r = await trySettle(signer, m.id);
                  if (r.sig) addSig("settle", r.sig);
                  if (r.outcome === "waiting-opponent") setError("Your opponent is still playing.");
                  if (r.outcome === "failed") setError(r.error ?? "Couldn’t finish the Match. Try again.");
                })
              }
            >
              {busy === "settle" ? "Checking…" : "Check result"}
            </Button>
            {timeoutOk && (
              <div className="stack">
                <p className="note">Time ran out and nobody played. Both entries can be refunded.</p>
                <Button disabled={busy !== null} onClick={() => act("timeout", async () => addSig("claim_timeout", await claimTimeout(signer, m.id)))}>
                  Refund both entries
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {m && refundable && (phase === "awaiting" || phase === "ready" || phase === "prep") && (
        <Button disabled={busy !== null} onClick={() => act("refund", async () => addSig("refund", await refundMatch(signer, m.id)))}>
          Refund Match
        </Button>
      )}

      {error && <p className="status err" role="alert">{error}</p>}

      <Receipts items={sigs} />
      <p className="note">Test mode · Gemas come from simulated yield and have no real value.</p>
    </div>
  );
}

function fmtFee(m: ChainMatch): string {
  const pot = m.entry * 2;
  return String(Math.floor((pot * m.fees.platformBps) / 10_000) + Math.floor((pot * m.fees.studioBps) / 10_000));
}

