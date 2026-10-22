"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Busy, Button, GemaAmount } from "@/components/ui";
import { PlayerAvatar, usePlayerLabel } from "@/components/account/Player";
import { FriendPicker } from "@/components/friends/FriendPicker";
import { useFriends } from "@/lib/friends/FriendsProvider";
import { FriendsError } from "@/lib/friends/client";
import { useQueue } from "@/components/lobby/useQueue";
import { useAccount } from "@/lib/account";
import { MAX_ENTRY_SOURCES, estimatedWin } from "@/lib/chain/ledger";
import { chainShortfall, checkGemas } from "@/lib/chain/fresh-gemas";
import { BackingError, createChallengeBacked, enterQueueBacked, joinChallengeBacked } from "@/lib/chain/backing";
import { seatsAt } from "@/lib/chain/lobby-plays";
import { ChallengeError, EntryError, QueueUnconfirmedError, createChallenge, enterQueue, joinChallenge, type Entered } from "@/lib/chain/match-flow";
import { DemoError } from "@/lib/chain/demo-client";
import { ageCall } from "@/lib/chain/age-client";
import { ageGate, readAgeCache, writeAgeCache } from "@/lib/age-gate";
import { AgeConfirm } from "./AgeConfirm";
import { fmtGemas } from "@/lib/format";
import { practiceHref } from "@/lib/game-params";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";
import { plainError } from "@/lib/errors";
import "./enter.css";
import { BRAND } from "@/lib/brand";

export type EnterKind =
  | { kind: "queue"; entry: number; game?: GameId; asset?: 0 | 1 | 2; backing?: string }
  | { kind: "challenge-new"; entry: number; game?: GameId; asset?: 0 | 1 | 2; backing?: string; /** A Rematch: the opponent of the Match being replayed. */ opponent?: string }
  | { kind: "challenge-join"; id: string; backing?: string };

/** What the Queue says once a seat is open: Block Burst is played while it waits, the others start when someone joins. */
const OPENED_LINE: Record<GameId, string> = {
  "block-puzzle": "Match opened. You'll be paired while you play.",
  holdem: "Entered the Queue.",
  "trading-duel": "Entered the Queue.",
  vanguard: "Entered the Queue.",
};

function explain(e: unknown): { text: string; short?: boolean } {
  if (e instanceof EntryError) {
    return e.code === "insufficient"
      ? { text: "You need more Gemas to join this Challenge. Get Gemas in your Wallet (free test SOL works).", short: true }
      : { text: `Your Gemas come from more than ${MAX_ENTRY_SOURCES} different Advances, and this entry cannot draw on that many. Redeem a few small balances in your Wallet to consolidate, then try again.` };
  }
  if (e instanceof ChallengeError || e instanceof BackingError || e instanceof QueueUnconfirmedError) return { text: e.message };
  if (e instanceof DemoError) return { text: e.message };
  return { text: plainError(e) };
}

/**
 * Sign-in gate -> Queue / Challenge -> the Match. For the Queue and a Challenge link, opening this page
 * is the confirmation; a new Challenge waits for Open Challenge, so a Friend can be picked first.
 * It runs once per visit.
 */
export function EnterMatch(props: EnterKind) {
  const { auth, snapshot, onChain, loading, gemas, refresh } = useAccount();
  const router = useRouter();
  const started = useRef(false);
  const attempted = useRef(false);
  const [status, setStatus] = useState("Getting your wallet ready…");
  const [failure, setFailure] = useState<{ text: string; short?: boolean } | null>(null);
  const [launched, setLaunched] = useState(false);
  const [existing, setExisting] = useState<bigint | null>(null);
  const friends = useFriends();
  const [picked, setPicked] = useState<string | null>(props.kind === "challenge-new" ? (props.opponent ?? null) : null);
  const [picking, setPicking] = useState(false);
  const [confirmed, setConfirmed] = useState(props.kind !== "challenge-new");
  const pickedName = usePlayerLabel(picked);
  const pickedFriend = picked !== null && friends.relation(picked) === "friend";
  /**
   * Shows the new Challenge to the picked Player if they are a Friend (the server checks; their Friends page, an
   * email if they opted in). The server reads the new Match from its own RPC, which can lag a moment behind:
   * it retries a few times. The link works either way.
   */
  const tellFriend = async (id: bigint) => {
    if (!picked) return;
    for (let i = 0; i < 4; i++) {
      try {
        await friends.act("challenge", { matchId: id.toString(), to: picked });
        return;
      } catch (e) {
        if (!(e instanceof FriendsError && e.code === "not-your-challenge")) return;
        await new Promise((r) => setTimeout(r, 1200));
      }
    }
  };
  const [freshRead, setFreshRead] = useState<"ok" | "failed" | null>(null);
  const [ageServer, setAgeServer] = useState<boolean | null>(null);
  const [ageChecked, setAgeChecked] = useState(false);
  const [ageBusy, setAgeBusy] = useState(false);
  const [ageError, setAgeError] = useState<string | null>(null);
  const seats = useQueue();
  const game: GameId = props.kind === "challenge-join" ? "block-puzzle" : (props.game ?? "block-puzzle");
  const asset = props.kind === "challenge-join" ? 0 : (props.asset ?? 0);
  const signer = auth.signer;
  const signedOut = auth.status === "signed-out";
  const key = props.kind === "challenge-join" ? props.id : String(props.entry);
  // Own Gemas cover a new entry or Challenge; a Backing pays for itself and a joined Challenge is checked on chain.
  // Only before the entry starts: it reserves the Gemas and would trip this check itself.
  const gemasCheck = !launched && props.kind !== "challenge-join" && !props.backing && onChain && !loading ? checkGemas(gemas.available, props.entry, freshRead === "ok") : "enough";
  // A shortfall is only believed after a fresh read: Gemas from a Position that just opened may not be in the cached list yet.
  // When that read fails nothing is confirmed, so the entry goes ahead and the chain has the last word.
  const entryGemas = props.kind === "challenge-join" ? 0 : props.entry;
  // The chain refused for lack of Gemas while the balance shown covers the entry: the new Gemas are still landing.
  const landing = failure?.short === true && props.kind !== "challenge-join" && chainShortfall(gemas.available, entryGemas) === "landing";
  const needsGemas = props.kind !== "challenge-join" && (gemasCheck === "short" || (failure?.short === true && !landing));
  const rechecking = gemasCheck === "recheck" && freshRead !== "failed";

  useEffect(() => {
    if (!rechecking) return;
    let stopped = false;
    void refresh().then(
      (ok) => !stopped && setFreshRead(ok ? "ok" : "failed"),
      () => !stopped && setFreshRead("failed"),
    );
    return () => {
      stopped = true;
    };
  }, [rechecking, refresh]);

  const authorityKey = signer?.publicKey.toBase58() ?? null;
  // Only read once a signer exists, which is after hydration.
  const ageCached = authorityKey ? readAgeCache(authorityKey) : false;
  const gate = signer ? ageGate({ server: ageServer, cached: ageCached, checked: ageChecked }) : "checking";

  useEffect(() => {
    if (!signer || !authorityKey) return;
    if (readAgeCache(authorityKey)) return;
    let stopped = false;
    void ageCall("status", signer, auth.getAccessToken).then(
      (ok) => !stopped && (setAgeServer(ok), setAgeChecked(true)),
      () => !stopped && setAgeChecked(true),
    );
    return () => {
      stopped = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorityKey]);

  async function confirmAge() {
    if (!signer || !authorityKey) return;
    setAgeBusy(true);
    setAgeError(null);
    try {
      await ageCall("confirm", signer, auth.getAccessToken);
      writeAgeCache(authorityKey);
      setAgeServer(true);
    } catch (e) {
      setAgeError(plainError(e));
    } finally {
      setAgeBusy(false);
    }
  }

  useEffect(() => {
    // A failed attempt is retried by reloading the page, never by this effect re-running.
    if (!signer || !confirmed || started.current || attempted.current || loading || needsGemas || rechecking || gate !== "go") return;
    started.current = true;
    attempted.current = true;
    setLaunched(true);
    void (async () => {
      try {
        setStatus("Checking your SOL and Account…");
        const entered = (r: Entered, opened: string) => {
          if (r.via === "existing") return setExisting(r.id);
          setStatus(r.via === "joined" ? "Opponent found." : opened);
          router.replace(`/play/match/${r.id.toString()}`);
        };
        if (props.kind === "queue" && props.backing) {
          setStatus("Using your Backing…");
          entered(await enterQueueBacked(signer, props.backing, game, props.entry, auth.getAccessToken, setStatus, asset), "Entered the Queue.");
        } else if (props.kind === "challenge-new" && props.backing) {
          setStatus("Using your Backing to open your Challenge…");
          const r = await createChallengeBacked(signer, props.backing, game, props.entry, auth.getAccessToken, asset);
          await tellFriend(r.id);
          router.replace(`/play/match/${r.id.toString()}`);
        } else if (props.kind === "challenge-join" && props.backing) {
          setStatus("Joining the Challenge with your Backing…");
          await joinChallengeBacked(signer, props.backing, BigInt(props.id), auth.getAccessToken);
          router.replace(`/play/match/${props.id}`);
        } else if (props.kind === "queue") {
          const r = await enterQueue(signer, props.entry, auth.getAccessToken, props.game, setStatus, asset);
          entered(r, OPENED_LINE[game]);
        } else if (props.kind === "challenge-new") {
          const id = await createChallenge(signer, props.entry, auth.getAccessToken, props.game, asset, setStatus);
          await tellFriend(id);
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
  }, [signer, key, loading, needsGemas, rechecking, gate, confirmed]);

  const assetName = game === "trading-duel" ? (["SOL", "ETH", "HYPE"][asset] ?? "SOL") : "";
  const title = props.kind === "queue" ? "Play now" : props.kind === "challenge-new" ? "New Challenge" : "Challenge";
  const me = snapshot?.accountKey.toBase58() ?? null;
  // Players waiting at this entry you can be paired with (the opponent seat cycles through them while the Queue runs).
  // A Player you back never is: tesoro_core refuses that join.
  const here = props.kind === "queue" && seats ? seatsAt(seats[game].filter((w) => game !== "trading-duel" || w.asset === asset), props.entry, me ?? undefined) : { open: [], backed: 0 };
  const waiting = here.open;
  const found = status === "Opponent found.";
  const busy = !signedOut && existing === null && !needsGemas && !failure && gate !== "ask";
  const seat = found ? "Opponent" : props.kind === "challenge-new" ? (picked ? pickedName : "Your friend") : props.kind === "challenge-join" ? "Opponent" : waiting.length ? `${waiting.length} waiting` : "Open seat";
  const waitLine =
    props.kind === "challenge-new"
      ? pickedFriend
        ? `${pickedName} sees it on their Friends page. You also get a link to send.`
        : picked
          ? "Send them your link once the Match opens: they can accept or ignore it."
          : "Your link is ready once the Match opens."
      : props.kind === "challenge-join"
        ? "Joining your friend's Match."
        : waiting.length
          ? `${waiting.length} waiting at this entry: you take the oldest seat.`
          : here.backed
            ? `${here.backed === 1 ? "The Player waiting at this entry is one you back" : "The Players waiting at this entry are ones you back"}, and you can't play someone you back. ${game === "block-puzzle" ? "You play now and are paired with someone else." : "You sit first and the Match starts when someone else joins."}`
            : game === "block-puzzle"
              ? "No one waiting yet: you play now and are paired when someone joins."
              : `No one waiting yet: you sit first and the Match starts when someone joins${assetName ? ` (trading ${assetName})` : ""}.`;
  const heldLine = `${props.backing ? "The entry is" : `Your ${fmtGemas(entryGemas)} Gemas are`} held for this Match. If nobody joins within an hour, ${props.backing ? "it comes" : "they come"} back.`;
  return (
    <section className="enter" aria-label={title}>
      <header className="enter-head">
        <span className="enter-kicker">
          {GAME_NAMES[game]}
          {assetName ? ` · ${assetName}` : ""}
          {props.backing ? " · funded by your Backer" : ""}
        </span>
        <h1 className="enter-title">{found ? "Opponent found" : title}</h1>
      </header>
      <div className="enter-arena">
        <figure className="enter-seat">
          <span className="cut enter-av">{me ? <PlayerAvatar account={me} size={112} /> : <span className="enter-q">?</span>}</span>
          <figcaption>You</figcaption>
        </figure>
        <div className="enter-pot">
          {props.kind !== "challenge-join" ? (
            <div className="cut cut-card enter-plaque">
              <span className="enter-label">Your entry</span>
              <GemaAmount value={props.entry} size="lg" usd />
              <small>Winner takes {fmtGemas(estimatedWin(props.entry))} · after Fees</small>
            </div>
          ) : (
            <span className="enter-vs">VS</span>
          )}
        </div>
        <figure className={`enter-seat${busy && confirmed && !found ? " seeking" : ""}`}>
          <span className="cut enter-av">
            {props.kind === "challenge-new" && picked ? <PlayerAvatar account={picked} size={112} /> : <SeekingFace keys={found ? [] : waiting} />}
          </span>
          <figcaption>{seat}</figcaption>
          {props.kind === "challenge-new" && !confirmed && !signedOut && (
            <Button size="sm" onClick={() => setPicking(true)}>
              {picked ? "Change" : "Select friend"}
            </Button>
          )}
        </figure>
      </div>
      <div className="enter-foot">
        {signedOut ? (
          <>
            <p className="meta">Sign in to play a Match.</p>
            <Button block onClick={() => auth.openSignIn("Enter a Match")}>Sign in</Button>
          </>
        ) : gate === "ask" ? (
          <AgeConfirm busy={ageBusy} error={ageError} onConfirm={() => void confirmAge()} onDecline={() => router.replace("/lobby")} />
        ) : existing !== null ? (
          <>
            <p className="status" role="status">You still have a {GAME_NAMES[game]} Match to play. Finish it before entering another.</p>
            <div className="hstack wrap">
              <Button variant="money" href={`/play/match/${existing.toString()}`}>Continue</Button>
              <Button href="/lobby">Lobby</Button>
            </div>
          </>
        ) : needsGemas ? (
          <>
            <p className="status err" role="status">You need {fmtGemas(entryGemas)} Gemas to enter. You have {fmtGemas(gemas.available)}.</p>
            <div className="hstack wrap">
              <Button variant="money" href={`/wallet?open=1&need=${entryGemas}&game=${game}`}>Get Gemas</Button>
              <Button href={practiceHref(game, props.asset)}>Practice free</Button>
              <Button href="/lobby">Lobby</Button>
            </div>
          </>
        ) : failure ? (
          <>
            <p className="status err" role="alert">{landing ? "Your new Gemas are still landing. Try again in a few seconds." : failure.text}</p>
            <div className="hstack wrap">
              {failure.short && !landing ? <Button variant="money" href={`/wallet?open=1&game=${game}`}>Get Gemas</Button> : <Button onClick={() => window.location.reload()}>Retry</Button>}
              <Button href="/lobby">Lobby</Button>
            </div>
          </>
        ) : !confirmed ? (
          <>
            <Button variant="money" block onClick={() => setConfirmed(true)}>
              {picked ? `Open Challenge for ${pickedName}` : "Open Challenge"}
            </Button>
            <p className="meta">{waitLine}</p>
          </>
        ) : (
          <>
            <Busy>{status}</Busy>
            {!found && <p className="meta">{waitLine}</p>}
            {!found && props.kind !== "challenge-join" && <p className="meta">{heldLine}</p>}
          </>
        )}
        {onChain && snapshot && !snapshot.exists && <p className="note">First time: we create your {BRAND.name} Account as part of this step.</p>}
      </div>
      {props.kind === "challenge-new" && (
        <FriendPicker
          open={picking}
          picked={picked}
          onClose={() => setPicking(false)}
          onPick={(p) => setPicked(p)}
          onOpen={() => {
            setPicking(false);
            setConfirmed(true);
          }}
        />
      )}
    </section>
  );
}

/** The empty seat: flicks through the faces waiting in the Queue, or a question mark when there are none. */
function SeekingFace({ keys }: { keys: string[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (keys.length < 2) return;
    const t = setInterval(() => setI((n) => n + 1), 900);
    return () => clearInterval(t);
  }, [keys.length]);
  if (!keys.length) return <span className="enter-q">?</span>;
  const k = keys[i % keys.length];
  return <PlayerAvatar key={k} account={k} size={112} />;
}
