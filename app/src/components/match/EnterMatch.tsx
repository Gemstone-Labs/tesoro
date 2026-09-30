"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Card, GemaAmount } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { BackingError, createChallengeBacked, enterQueueBacked, joinChallengeBacked } from "@/lib/chain/backing";
import { ChallengeError, EntryError, createChallenge, enterQueue, joinChallenge } from "@/lib/chain/match-flow";
import { DemoError } from "@/lib/chain/demo-client";
import { GAME_NAMES } from "@/lib/mock";
import type { GameId } from "@/lib/mock";

export type EnterKind =
  | { kind: "queue"; entry: number; game?: GameId; backing?: string }
  | { kind: "challenge-new"; entry: number; game?: GameId; backing?: string }
  | { kind: "challenge-join"; id: string; backing?: string };

function explain(e: unknown): { text: string; wallet?: boolean } {
  if (e instanceof EntryError) {
    return e.code === "insufficient"
      ? { text: "You do not have enough Gemas for this entry. Take a demo Advance in your Wallet to get some.", wallet: true }
      : { text: "This entry would draw on more than two Sources. Play a smaller entry first to consolidate." };
  }
  if (e instanceof ChallengeError || e instanceof BackingError) return { text: e.message };
  if (e instanceof DemoError) return { text: e.message };
  return { text: e instanceof Error ? e.message.split("\n")[0] : String(e) };
}

/**
 * Sign-in gate -> Queue / Challenge -> the Match. Opening this page is the confirmation
 * (the Lobby's Enter button, or a Challenge link); it runs once per visit.
 */
export function EnterMatch(props: EnterKind) {
  const { auth, snapshot, onChain } = useAccount();
  const router = useRouter();
  const started = useRef(false);
  const [status, setStatus] = useState("Getting your wallet ready…");
  const [failure, setFailure] = useState<{ text: string; wallet?: boolean } | null>(null);
  const signer = auth.signer;
  const signedOut = auth.status === "signed-out";
  const key = props.kind === "challenge-join" ? props.id : String(props.entry);

  useEffect(() => {
    if (!signer || started.current) return;
    started.current = true;
    void (async () => {
      try {
        setStatus("Checking your SOL and Account…");
        const game = props.kind === "challenge-join" ? "block-puzzle" : (props.game ?? "block-puzzle");
        if (props.kind === "queue" && props.backing) {
          setStatus("Using your Backing…");
          const r = await enterQueueBacked(signer, props.backing, game, props.entry, auth.getAccessToken);
          setStatus(r.joined ? "Opponent found." : "Entered the Queue.");
          router.replace(`/play/match/${r.id.toString()}`);
        } else if (props.kind === "challenge-new" && props.backing) {
          const r = await createChallengeBacked(signer, props.backing, game, props.entry, auth.getAccessToken);
          router.replace(`/play/match/${r.id.toString()}`);
        } else if (props.kind === "challenge-join" && props.backing) {
          setStatus("Joining the Challenge with your Backing…");
          await joinChallengeBacked(signer, props.backing, BigInt(props.id), auth.getAccessToken);
          router.replace(`/play/match/${props.id}`);
        } else if (props.kind === "queue") {
          const r = await enterQueue(signer, props.entry, auth.getAccessToken, props.game);
          setStatus(r.joined ? "Opponent found." : props.game === "holdem" ? "Entered the Queue." : "Match opened. You'll be paired while you play.");
          router.replace(`/play/match/${r.id.toString()}`);
        } else if (props.kind === "challenge-new") {
          const id = await createChallenge(signer, props.entry, auth.getAccessToken, props.game);
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
  }, [signer, key]);

  const title = props.kind === "queue" ? "Play now" : props.kind === "challenge-new" ? "New Challenge" : "Challenge";
  return (
    <Card large as="section" aria-label={title} style={{ maxWidth: 480, margin: "0 auto" }}>
      <div className="stack">
        <h1 className="page-title">{title}</h1>
        {props.kind === "queue" && <p className="meta">Play now — you&apos;ll be paired with the next Player. Your run counts against theirs.</p>}
        {props.kind !== "challenge-join" && (
          <span className="hstack">
            <GemaAmount value={props.entry} size="lg" />{" "}
            <span className="meta">
              entry · {GAME_NAMES[props.game ?? "block-puzzle"]}
              {props.backing ? " · funded by your Backer" : ""}
            </span>
          </span>
        )}
        {signedOut ? (
          <>
            <p className="meta">Sign in to play a Match.</p>
            <Button block onClick={() => auth.openSignIn("Enter a Match")}>Sign in</Button>
          </>
        ) : failure ? (
          <>
            <p className="status err" role="alert">{failure.text}</p>
            <div className="hstack wrap">
              {failure.wallet && <Button variant="money" href="/wallet">Open Wallet</Button>}
              <Button onClick={() => window.location.reload()}>Try again</Button>
              <Button href="/">Lobby</Button>
            </div>
          </>
        ) : (
          <p className="status" role="status">{status}</p>
        )}
        {onChain && snapshot && !snapshot.exists && <p className="note">First time: your Account is created on Solana devnet.</p>}
      </div>
    </Card>
  );
}
