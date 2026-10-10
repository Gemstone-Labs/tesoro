"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PrototypeSwitcher } from "@/components/prototype/PrototypeSwitcher";
import { useQueue } from "@/components/lobby/useQueue";
import { BUSY_LOOP, DEMO_KEYS, QueueVariant, VARIANTS, type Phase, type VariantKey } from "./QueueVariants.prototype";
import { Busy, Button, Card, GemaAmount } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { MAX_ENTRY_SOURCES } from "@/lib/chain/ledger";
import { BackingError, createChallengeBacked, enterQueueBacked, joinChallengeBacked } from "@/lib/chain/backing";
import { ChallengeError, EntryError, QueueUnconfirmedError, createChallenge, enterQueue, joinChallenge, type Entered } from "@/lib/chain/match-flow";
import { DemoError } from "@/lib/chain/demo-client";
import { fmtGemas } from "@/lib/format";
import { practiceHref } from "@/lib/game-params";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";
import { plainError } from "@/lib/errors";

export type EnterKind =
  | { kind: "queue"; entry: number; game?: GameId; asset?: 0 | 1 | 2; backing?: string }
  | { kind: "challenge-new"; entry: number; game?: GameId; asset?: 0 | 1 | 2; backing?: string }
  | { kind: "challenge-join"; id: string; backing?: string };

function explain(e: unknown): { text: string; wallet?: boolean } {
  if (e instanceof EntryError) {
    return e.code === "insufficient"
      ? { text: "You do not have enough Gemas for this entry. Open a Position in your Wallet to get some (free test simSOL works).", wallet: true }
      : { text: `Your Gemas are spread over more than ${MAX_ENTRY_SOURCES} Sources, and this entry cannot draw on that many. Redeem a few small balances in your Wallet to consolidate, then try again.` };
  }
  if (e instanceof ChallengeError || e instanceof BackingError || e instanceof QueueUnconfirmedError) return { text: e.message };
  if (e instanceof DemoError) return { text: e.message };
  return { text: plainError(e) };
}

/**
 * Sign-in gate -> Queue / Challenge -> the Match. Opening this page is the confirmation
 * (the Lobby's Enter button, or a Challenge link); it runs once per visit.
 */
export function EnterMatch(props: EnterKind) {
  const { auth, snapshot, onChain, loading, gemas } = useAccount();
  const router = useRouter();
  const started = useRef(false);
  const attempted = useRef(false);
  const [status, setStatus] = useState("Getting your wallet ready…");
  const [failure, setFailure] = useState<{ text: string; wallet?: boolean } | null>(null);
  const [launched, setLaunched] = useState(false);
  const [existing, setExisting] = useState<bigint | null>(null);
  const signer = auth.signer;
  const signedOut = auth.status === "signed-out";
  const key = props.kind === "challenge-join" ? props.id : String(props.entry);
  // Own Gemas cover a new entry or Challenge; a Backing pays for itself and a joined Challenge is checked on chain.
  // Only before the entry starts: it reserves the Gemas and would trip this check itself.
  // PROTOTYPE: with ?variant= in the URL nothing runs on chain; ?state= picks what is shown.
  const params = useSearchParams();
  const proto = params.has("variant");
  const variant = (VARIANTS.find((x) => x.key === params.get("variant"))?.key ?? "A") as VariantKey;
  const forced = params.get("state") ?? "busy";
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!proto || forced !== "busy") return;
    const t = setInterval(() => setTick((n) => n + 1), 1800);
    return () => clearInterval(t);
  }, [proto, forced]);
  const seats = useQueue();
  const needsGemas = !proto && !launched && props.kind !== "challenge-join" && !props.backing && onChain && !loading && gemas.available < props.entry;

  useEffect(() => {
    // A failed attempt is retried by reloading the page, never by this effect re-running.
    if (proto || !signer || started.current || attempted.current || loading || needsGemas) return;
    started.current = true;
    attempted.current = true;
    setLaunched(true);
    void (async () => {
      try {
        setStatus("Checking your SOL and Account…");
        const game = props.kind === "challenge-join" ? "block-puzzle" : (props.game ?? "block-puzzle");
        const asset = props.kind === "challenge-join" ? 0 : (props.asset ?? 0);
        const entered = (r: Entered, opened: string) => {
          if (r.via === "existing") return setExisting(r.id);
          setStatus(r.via === "joined" ? "Opponent found." : opened);
          router.replace(`/play/match/${r.id.toString()}`);
        };
        if (props.kind === "queue" && props.backing) {
          setStatus("Using your Backing…");
          entered(await enterQueueBacked(signer, props.backing, game, props.entry, auth.getAccessToken, setStatus, asset), "Entered the Queue.");
        } else if (props.kind === "challenge-new" && props.backing) {
          const r = await createChallengeBacked(signer, props.backing, game, props.entry, auth.getAccessToken, asset);
          router.replace(`/play/match/${r.id.toString()}`);
        } else if (props.kind === "challenge-join" && props.backing) {
          setStatus("Joining the Challenge with your Backing…");
          await joinChallengeBacked(signer, props.backing, BigInt(props.id), auth.getAccessToken);
          router.replace(`/play/match/${props.id}`);
        } else if (props.kind === "queue") {
          const r = await enterQueue(signer, props.entry, auth.getAccessToken, props.game, setStatus, asset);
          entered(r, props.game === "holdem" || props.game === "trading-duel" ? "Entered the Queue." : "Match opened. You'll be paired while you play.");
        } else if (props.kind === "challenge-new") {
          const id = await createChallenge(signer, props.entry, auth.getAccessToken, props.game, asset);
          router.replace(`/play/match/${id.toString()}`);
        } else {
          setStatus("Joining the Challenge…");
          await joinChallenge(signer, BigInt(props.id), auth.getAccessToken);
          router.replace(`/play/match/${props.id}`);
        }
      } catch (e) {
        started.current = false;
        setFailure(explain(e));
      }
    })();
    // The mode and entry are fixed for this page instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signer, key, loading, needsGemas]);

  const assetName = props.kind !== "challenge-join" && props.game === "trading-duel" ? (["SOL", "ETH", "HYPE"][props.asset ?? 0] ?? "SOL") : "";
  const title = props.kind === "queue" ? "Play now" : props.kind === "challenge-new" ? "New Challenge" : "Challenge";
  const game: GameId = props.kind === "challenge-join" ? "block-puzzle" : (props.game ?? "block-puzzle");
  const me = snapshot?.accountKey?.toBase58?.() ?? null;
  const fakeN = Number(params.get("waiting") ?? NaN);
  const realWaiting = [...new Set((seats?.[game] ?? []).filter((w) => props.kind !== "challenge-join" && w.entry === props.entry && w.player !== me && (game !== "trading-duel" || w.asset === (props.asset ?? 0))).map((w) => w.player))];
  const waiting = Number.isFinite(fakeN) ? DEMO_KEYS.slice(0, Math.min(fakeN, 4)).concat(Array.from({ length: Math.max(0, fakeN - 4) }, () => DEMO_KEYS[0])).slice(0, fakeN) : realWaiting;
  const protoPhase: Phase =
    forced === "signed-out" ? { kind: "signed-out" }
    : forced === "existing" ? { kind: "existing", href: "/lobby" }
    : forced === "gemas" ? { kind: "gemas", have: 320 }
    : forced === "failure" ? { kind: "failure", text: "The network is busy. Your Gemas were not spent: try again in a moment." }
    : forced === "found" ? { kind: "busy", status: "Opponent found." }
    : { kind: "busy", status: BUSY_LOOP[tick % BUSY_LOOP.length] };
  const realPhase: Phase = signedOut ? { kind: "signed-out" } : existing !== null ? { kind: "existing", href: `/play/match/${existing.toString()}` } : needsGemas ? { kind: "gemas", have: gemas.available } : failure ? { kind: "failure", ...failure } : { kind: "busy", status };
  const phase = proto ? protoPhase : realPhase;
  const switcher = proto || process.env.NODE_ENV !== "production" ? <PrototypeSwitcher variants={VARIANTS.map((x) => ({ key: x.key, name: x.name }))} /> : null;
  if (variant !== "now")
    return (
      <>
        <QueueVariant
          variant={variant}
          v={{
            title,
            mode: props.kind,
            game,
            entry: props.kind === "challenge-join" ? null : props.entry,
            assetName,
            backed: !!props.backing,
            me: me ?? (proto ? DEMO_KEYS[3] : null),
            waiting,
            opponent: forced === "found" && proto ? (waiting[0] ?? DEMO_KEYS[1]) : null,
            phase,
            practice: practiceHref(game, props.kind === "challenge-join" ? undefined : props.asset),
            signIn: () => auth.openSignIn("Enter a Match"),
          }}
        />
        {switcher}
      </>
    );
  if (proto) {
    // The current layout, frozen on the forced state.
    return (
      <>
        <Card large as="section" aria-label={title} className="enter-card">
          <div className="stack">
            <h1 className="page-title">{title}</h1>
            {props.kind === "queue" && <p className="meta">Play now — you&apos;ll be paired with the next Player. Your run counts against theirs.</p>}
            {props.kind !== "challenge-join" && (
              <span className="hstack">
                <GemaAmount value={props.entry} size="lg" /> <span className="meta">entry · {GAME_NAMES[game]}</span>
              </span>
            )}
            {phase.kind === "busy" ? <Busy>{phase.status}</Busy> : <p className="status err">{phase.kind}</p>}
          </div>
        </Card>
        {switcher}
      </>
    );
  }
  return (
    <Card large as="section" aria-label={title} className="enter-card">
      <div className="stack">
        <h1 className="page-title">{title}</h1>
        {props.kind === "queue" && props.game === "trading-duel" && <p className="meta">Play now — you&apos;ll be paired with the next Player trading {assetName}. The Match starts as soon as you are paired.</p>}
        {props.kind === "queue" && props.game !== "trading-duel" && <p className="meta">Play now — you&apos;ll be paired with the next Player. Your run counts against theirs.</p>}
        {props.kind !== "challenge-join" && (
          <span className="hstack">
            <GemaAmount value={props.entry} size="lg" />{" "}
            <span className="meta">
              entry · {GAME_NAMES[props.game ?? "block-puzzle"]}
              {props.game === "trading-duel" ? ` · ${assetName}` : ""}
              {props.backing ? " · funded by your Backer" : ""}
            </span>
          </span>
        )}
        {signedOut ? (
          <>
            <p className="meta">Sign in to play a Match.</p>
            <Button block onClick={() => auth.openSignIn("Enter a Match")}>Sign in</Button>
          </>
        ) : existing !== null ? (
          <>
            <p className="status" role="status">You still have a {GAME_NAMES[props.kind === "challenge-join" ? "block-puzzle" : (props.game ?? "block-puzzle")]} Match to play. Finish it before entering another.</p>
            <div className="hstack wrap">
              <Button variant="money" href={`/play/match/${existing.toString()}`}>Continue</Button>
              <Button href="/lobby">Lobby</Button>
            </div>
          </>
        ) : needsGemas ? (
          <>
            <p className="status err" role="status">You need {fmtGemas(props.entry)} Gemas to enter. You have {fmtGemas(gemas.available)}.</p>
            <div className="hstack wrap">
              <Button variant="money" href="/wallet?open=1">Get Gemas</Button>
              <Button href={practiceHref(props.game ?? "block-puzzle", props.asset)}>Practice free</Button>
              <Button href="/lobby">Lobby</Button>
            </div>
          </>
        ) : failure ? (
          <>
            <p className="status err" role="alert">{failure.text}</p>
            <div className="hstack wrap">
              {failure.wallet && <Button variant="money" href="/wallet">Open Wallet</Button>}
              <Button onClick={() => window.location.reload()}>Try again</Button>
              <Button href="/lobby">Lobby</Button>
            </div>
          </>
        ) : (
          <Busy>{status}</Busy>
        )}
        {onChain && snapshot && !snapshot.exists && <p className="note">First time: we create your Tesoro Account as part of this step.</p>}
      </div>
    </Card>
  );
}
