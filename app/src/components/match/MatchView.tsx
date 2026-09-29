"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, CheckIcon, Chip, GemaAmount, Label, MinusIcon, XIcon } from "@/components/ui";
import { BlockPuzzleGame, type MatchRun } from "@/games/block-puzzle/BlockPuzzleGame";
import { BlockPuzzleChain, type Seat } from "@/games/block-puzzle/chain";
import { useAccount } from "@/lib/account";
import { getChain } from "@/lib/chain/client";
import { matchDelta } from "@/lib/chain/ledger";
import { RunSubmitter, canClaimTimeout, claimTimeout, prepareRun, probeRun, refundMatch, trySettle } from "@/lib/chain/match-flow";
import { fetchMatch, type ChainMatch } from "@/lib/chain/read";
import { fmtGemas } from "@/lib/format";

type Phase =
  | "loading"
  | "notfound"
  | "spectator"
  | "waiting"
  | "prep"
  | "ready"
  | "starting"
  | "playing"
  | "submitting"
  | "awaiting"
  | "result";

const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const errText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
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
      setRefundable(!!m && m.status === "active" && !m.session && Date.now() / 1000 > m.deadline);
      if (!m) return setPhase("notfound");
      if (m.seat === null) return setPhase("spectator");
      if (m.status === "open") return setPhase("waiting");
      if (m.status === "settled" || m.status === "refunded") {
        if (!settledSeen.current) {
          settledSeen.current = true;
          void refresh();
        }
        return setPhase("result");
      }

      const stage = await probeRun(signer, m);
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
      setPhase("awaiting");
      if (await canClaimTimeout(m)) setTimeoutOk(true);
      if (Date.now() - lastSettle.current >= SETTLE_TRY_MS) {
        lastSettle.current = Date.now();
        const r = await trySettle(signer, id);
        if (r.sig) addSig("settle", r.sig);
        if (r.outcome === "settled") setMatch(await fetchMatch(id, me));
        if (r.outcome === "failed") setError(r.error ?? "Settlement failed");
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
      const sig = await getChain().beginRun(signer, id, seat);
      addSig("begin_run (private)", sig);
      const sub = new RunSubmitter(signer, id, seat);
      submitter.current = sub;
      setRun({
        seed: match.session.seed,
        startedAt,
        entry: match.entry,
        onMove: (mv) => sub.push(mv),
        onEnd: (f) => {
          setFinal(f);
          setPhase("submitting");
          void (async () => {
            await sub.finish();
            if (sub.error) setError(`Some moves were not accepted: ${errText(sub.error)}`);
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
  if (auth.status === "signed-out") {
    return (
      <Card large as="section" aria-label="Sign in to see this Match">
        <div className="stack">
          <h1 className="page-title">Match</h1>
          <p className="meta">Sign in to play this Match.</p>
          <Button block onClick={() => auth.openSignIn("Enter a Match")}>Sign in</Button>
        </div>
      </Card>
    );
  }
  if (!signer) return <Notice title="Match" body="Getting your wallet ready…" />;
  if (phase === "loading") return <Notice title="Match" body="Reading the Match from Solana devnet…" />;
  if (phase === "notfound") return <Notice title="Match not found" body="No Match with that id on devnet." />;
  if (phase === "spectator") {
    return <Notice title="Not your Match" body="You are not one of the two Players of this Match." />;
  }

  if (phase === "playing" && run) {
    return (
      <div className="stack">
        <BlockPuzzleGame run={run} />
        {error && <p className="status err" role="alert">{error}</p>}
      </div>
    );
  }

  const m = match;
  const link = typeof window === "undefined" || !m ? "" : `${window.location.origin}/play/challenge/${m.id.toString()}`;
  const session = m?.session;
  const mineIdx = m?.seat ?? 0;
  const scores = session ? [session.scores[mineIdx], session.scores[1 - mineIdx]] : null;
  const delta = m ? matchDelta(m) : 0;
  const outcome = !m || m.status === "open" || m.status === "active" ? null : !session ? "refunded" : session.result === "draw" ? "draw" : delta > 0 ? "won" : "lost";

  return (
    <div className="stack-lg" style={{ maxWidth: 480, margin: "0 auto" }}>
      <div className="spread">
        <h1 className="page-title">Block Puzzle Match</h1>
        {m && (
          <Chip tone="money">
            <GemaAmount value={m.entry} size="sm" /> entry
          </Chip>
        )}
      </div>

      {phase === "waiting" && m && (
        <Card large>
          <div className="stack">
            <Label>Waiting for an opponent</Label>
            <p className="meta">
              Your entry of {fmtGemas(m.entry)} Gemas is held in escrow. Your run starts the moment an opponent joins: on
              chain both Players get the same Seed and their own private Board, so play begins once you are paired. Keep this page open, or come back from the Lobby.
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
              {busy === "refund" ? "Refunding…" : "Cancel and refund entry"}
            </Button>
          </div>
        </Card>
      )}

      {phase === "prep" && (
        <Card large>
          <div className="stack">
            <Label>Opponent found · getting the Match ready</Label>
            <p className="status" role="status">{step || "Preparing"}…</p>
            <p className="note">Both Boards move to a private rollup so neither Player can see the other&apos;s moves. About 20 seconds.</p>
          </div>
        </Card>
      )}

      {(phase === "ready" || phase === "starting") && m && (
        <Card large>
          <div className="stack">
            <Label>Ready</Label>
            <p className="meta">
              You and your opponent play the same Seed, 90 seconds each. The clock starts when you press Start. Higher
              score wins {fmtGemas(m.entry * 2 - Number(fmtFee(m)))} Gemas.
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
            <p className="status" role="status">Sending your last moves to the chain…</p>
          </div>
        </Card>
      )}

      {phase === "awaiting" && m && (
        <Card large>
          <div className="stack">
            <Label>Waiting for the opponent</Label>
            {final && <span className="bp-final tnum">{final.score}</span>}
            <p className="meta">
              Your run is closed and hidden in the private rollup. When your opponent finishes (or their time runs out),
              both Boards are committed and the Match settles.
            </p>
            <p className="status" role="status">Checking every few seconds…</p>
            <Button
              disabled={busy !== null}
              onClick={() =>
                act("settle", async () => {
                  const r = await trySettle(signer, m.id);
                  if (r.sig) addSig("settle", r.sig);
                  if (r.outcome === "waiting-opponent") setError("Your opponent is still playing.");
                  if (r.outcome === "failed") setError(r.error ?? "Settlement failed");
                })
              }
            >
              {busy === "settle" ? "Settling…" : "Settle Match"}
            </Button>
            {timeoutOk && (
              <div className="stack">
                <p className="note">The submission deadline passed and nobody played. Both entries can be refunded.</p>
                <Button disabled={busy !== null} onClick={() => act("timeout", async () => addSig("claim_timeout", await claimTimeout(signer, m.id)))}>
                  Claim timeout
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {phase === "result" && m && outcome && (
        <Card large>
          <div className="stack">
            <span className="hstack">
              {outcome === "won" ? (
                <Chip tone="money" icon={<CheckIcon />}>Won</Chip>
              ) : outcome === "lost" ? (
                <Chip tone="danger" icon={<XIcon />}>Lost</Chip>
              ) : outcome === "draw" ? (
                <Chip icon={<MinusIcon />}>Draw</Chip>
              ) : (
                <Chip icon={<MinusIcon />}>Refunded</Chip>
              )}
              <GemaAmount value={delta} size="lg" sign />
            </span>
            {scores && (
              <dl className="kv">
                <dt>Your score</dt>
                <dd>{scores[0]}</dd>
                <dt>Opponent</dt>
                <dd>{scores[1]}</dd>
                <dt>Entry</dt>
                <dd>{fmtGemas(m.entry)} Gemas</dd>
                {outcome === "won" && (
                  <>
                    <dt>Fees taken from the loser</dt>
                    <dd>{fmtFee(m)} Gemas</dd>
                  </>
                )}
              </dl>
            )}
            {outcome === "refunded" && <p className="meta">The Match ended without a result and your entry was returned.</p>}
            {outcome === "draw" && <p className="meta">Equal scores: both entries were returned.</p>}
            <div className="hstack wrap">
              <Button variant="money" href={`/play/queue?entry=${m.entry}`}>Play again</Button>
              <Button href="/">Lobby</Button>
              <Button href="/wallet">Wallet</Button>
            </div>
          </div>
        </Card>
      )}

      {m && refundable && (phase === "awaiting" || phase === "ready" || phase === "prep") && (
        <Button disabled={busy !== null} onClick={() => act("refund", async () => addSig("refund", await refundMatch(signer, m.id)))}>
          Refund Match
        </Button>
      )}

      {error && <p className="status err" role="alert">{error}</p>}

      {sigs.length > 0 && (
        <div className="stack">
          <Label>Transactions</Label>
          {sigs.map((s) => (
            <a key={s.sig} className="meta mono" href={explorer(s.sig)} target="_blank" rel="noreferrer">
              {s.label} · {s.sig.slice(0, 10)}…
            </a>
          ))}
        </div>
      )}
      <p className="note">Solana devnet · testnet Gemas from a simulated Position.</p>
    </div>
  );
}

function fmtFee(m: ChainMatch): string {
  const pot = m.entry * 2;
  return String(Math.floor((pot * m.fees.platformBps) / 10_000) + Math.floor((pot * m.fees.studioBps) / 10_000));
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <Card large as="section">
      <div className="stack">
        <h1 className="page-title">{title}</h1>
        <p className="meta">{body}</p>
        <Button href="/">Lobby</Button>
      </div>
    </Card>
  );
}
