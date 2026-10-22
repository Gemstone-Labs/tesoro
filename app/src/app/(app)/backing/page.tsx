"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { PublicKey } from "@solana/web3.js";
import { X as XMark } from "lucide-react";
import {
  AssetPicker,
  Button,
  Card,
  CheckIcon,
  BustCard,
  Chip,
  EntryPicker,
  GemaMark,
  Label,
  Sheet,
  SkeletonCards,
  Slider,
  XIcon,
  Select,
} from "@/components/ui";
import { PlayerName } from "@/components/account/Player";
import { useGuideTip } from "@/components/guide/Guide";
import { useAccount } from "@/lib/account";
import {
  acceptDirected,
  cancelOffer,
  cancelRequest,
  expireOffer,
  fetchBackingBoard,
  postOffer,
  postRequest,
  type ChainOffer,
  type ChainRequest,
  type PlayerRecord,
} from "@/lib/chain/backing";
import { liveRequestFor, onePerPlayer } from "@/lib/chain/requests";
import { backedSplit, EntryError, MAX_ENTRY_SOURCES } from "@/lib/chain/ledger";
import { recordFromMatches, recordText, timeLeft, useBackingBoard } from "@/lib/chain/useBackingBoard";
import { fmtGemas } from "@/lib/format";
import { backingQuery } from "@/lib/game-params";
import { GAME_NAMES } from "@/lib/mock";
import type { EntrySize, GameId } from "@/lib/mock";

const GAME_OPTIONS = (["block-puzzle", "holdem", "trading-duel"] as const).map((g) => ({ value: g as GameId, label: GAME_NAMES[g] }));
const SORT_OPTIONS: { value: Sort; label: string }[] = [
  { value: "recent", label: "Newest" },
  { value: "entry", label: "Biggest entry" },
  { value: "record", label: "Best win rate" },
];
import { GemasLabel } from "../wallet/AdvanceQuote";
import { RequestCard } from "@/components/backing/RequestCard";
import { BackingExample, FEES } from "./BackingExample";
import "./backing.css";
import { plainError } from "@/lib/errors";
import { awayNotice } from "@/lib/chain/protections";
import { useAway } from "@/lib/chain/useAway";
import { wantsPostRequest } from "@/lib/backing/post-link";

const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

type Tab = "requests" | "mine";
type Sort = "recent" | "entry" | "record";

const winRate = (r: PlayerRecord) => (r.matches === 0 ? 0 : r.wins / r.matches);

function explain(e: unknown): string {
  if (e instanceof EntryError) {
    return e.code === "insufficient"
      ? "Not enough available Gemas. Gemas reserved for your other Offers cannot be reserved again."
      : `This entry would draw on Gemas from more than ${MAX_ENTRY_SOURCES} Advances. Redeem a few small balances in your Vault first.`;
  }
  return plainError(e);
}

function onHashChange(notify: () => void) {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
}

function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}


export default function Backing() {
  const { board, loading, error: loadError, refresh } = useBackingBoard();
  const { auth, snapshot, gemas, onChain, refresh: refreshAccount } = useAccount();
  useGuideTip({
    id: "backing-first",
    pose: "herBacking",
    title: "What Backing means",
    text: "A Backer funds a Player's whole entry. On a win the entry returns first and the surplus is split by the Offer. Only the Backer bears a loss.",
  });
  const router = useRouter();
  const away = useAway();
  const awayText = away ? awayNotice(away) : null;
  const nowMs = useNow();
  const nowSecs = Math.floor(nowMs / 1000);
  const me = snapshot?.accountKey.toBase58() ?? null;
  const [offerFor, setOfferFor] = useState<ChainRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; sig?: string } | null>(null);
  const [tab, setTab] = useState<Tab>("requests");
  const [sort, setSort] = useState<Sort>("recent");
  const [postOpen, setPostOpen] = useState(false);

  const requests = board?.requests ?? [];
  const offers = board?.offers ?? [];
  const requestByAddress = new Map(requests.map((r) => [r.address.toBase58(), r]));

  const pending = (r: ChainRequest) => offers.some((o) => o.status === "accepted" && o.request === r.address.toBase58());
  const myRequests = requests.filter((r) => r.player === me && (r.live || (r.status === "accepted" && pending(r))));
  const backings = offers.filter((o) => o.status === "accepted" && o.player === me && nowSecs < o.useBy);
  const offersForMe = offers.filter(
    (o) => o.status === "open" && nowSecs < o.expiresAt && o.directedTo && myRequests.some((r) => r.live && r.address.toBase58() === o.directedTo),
  );
  const sorted = <T extends { entry: number; expiresAt: number }>(xs: T[], rec: (x: T) => PlayerRecord | null) =>
    [...xs].sort((a, b) =>
      sort === "entry" ? b.entry - a.entry : sort === "record" ? winRate(rec(b) ?? { matches: 0, wins: 0 }) - winRate(rec(a) ?? { matches: 0, wins: 0 }) : b.expiresAt - a.expiresAt,
    );
  const others = sorted(
    onePerPlayer(requests.filter((r) => r.player !== me)),
    (r) => r.record,
  );
  const mine = offers.filter((o) => o.backer === me && ["open", "accepted", "consumed"].includes(o.status));
  const offeredTo = new Set(mine.filter((o) => o.status === "open" && nowSecs < o.expiresAt && o.directedTo).map((o) => o.directedTo));

  const run = (key: string, label: string | (() => string), fn: () => Promise<string | undefined>) => {
    setBusy(key);
    setError(null);
    setDone(null);
    void (async () => {
      try {
        const sig = await fn();
        setDone({ text: typeof label === "function" ? label() : label, sig });
        await Promise.all([refresh(), refreshAccount()]);
      } catch (e) {
        setError(explain(e));
      } finally {
        setBusy(null);
      }
    })();
  };
  const act = (reason: string, key: string, label: string | (() => string), fn: (s: NonNullable<typeof auth.signer>) => Promise<string | undefined>) =>
    auth.gate(reason, () =>
      run(key, label, async () => {
        if (!auth.signer) throw new Error("Your wallet is not ready yet. Try again in a moment.");
        return fn(auth.signer);
      }),
    );

  /** The board as the chain has it now: a stale or empty list must never lead to a duplicate Request. */
  const freshRequests = async () => {
    const { demoMode } = await import("@/lib/chain/fixture");
    return demoMode() ? requests : (await fetchBackingBoard()).requests;
  };
  const [highlight, setHighlight] = useState<string | null>(null);
  useEffect(() => {
    if (tab === "requests" && highlight) document.getElementById(`rq-${highlight}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [tab, highlight, requests.length]);

  // `/backing#<request>` (the Lobby rail, a Player's Account) opens the Offer on that Request, once the
  // board is read and it is known whether the Request is the visitor's own.
  const hash = useSyncExternalStore(onHashChange, () => window.location.hash.slice(1), () => "");
  const hashRead = useRef(false);
  const meKnown = auth.status === "signed-out" || (auth.status === "signed-in" && !!snapshot);
  const linked = hash && meKnown ? requests.find((r) => r.address.toBase58() === hash && r.player !== me) : undefined;
  const linkedOffered = !!linked && offeredTo.has(hash);
  useEffect(() => {
    if (hashRead.current || !linked) return;
    hashRead.current = true;
    if (linked.live && !linkedOffered) auth.gate("make an Offer", () => setOfferFor(linked));
  }, [linked, linkedOffered, auth]);

  // `/backing?post=1` (the Vault's Borrow Gemas) opens Post a Request once sign-in is known, then drops the query.
  const postRead = useRef(false);
  const canPost = auth.status === "signed-in" || auth.status === "signed-out";
  useEffect(() => {
    if (postRead.current || !canPost || !wantsPostRequest(window.location.search)) return;
    postRead.current = true;
    router.replace("/backing", { scroll: false });
    if (!awayText) auth.gate("post a Request", () => setPostOpen(true));
  }, [canPost, awayText, auth, router]);

  const selected = offerFor ? offerFor.address.toBase58() : null;
  const tabs: [Tab, string][] = [
    ["requests", "Requests"],
    ["mine", "My Backings"],
  ];

  return (
    <div className="bk">
      <header className="page-head">
        <div>
          <h1 className="page-title">Back a player</h1>
          <p className="page-sub">Support skilled players and share their success.</p>
        </div>
        {awayText ? (
          <p className="status" role="status">{awayText}</p>
        ) : (
          <div className="bk-head-actions">
            <Button variant="money" onClick={() => auth.gate("post a Request", () => setPostOpen(true))}>Post a Request</Button>
          </div>
        )}
      </header>

      {error && <p className="status err" role="alert">{error}</p>}
      {linked && !linked.live && <p className="status" role="status">That Request is no longer open.</p>}
      {done && (
        <div className="status ok" role="status">
          <CheckIcon /> {done.text}
          {done.sig && (
            <>
              {" "}
              <a className="mono" href={explorer(done.sig)} target="_blank" rel="noreferrer">
                {done.sig.slice(0, 8)}…
              </a>
            </>
          )}
        </div>
      )}
      {loadError && !board && (
        <div className="stack" role="alert">
          <p className="status err">Backing couldn’t be loaded. {loadError}</p>
          <Button size="sm" onClick={() => void refresh()}>Try again</Button>
        </div>
      )}

      {backings.length > 0 && (
        <section className="stack" aria-labelledby="bk-h">
          <Label><span id="bk-h">Your Backings: ready to play</span></Label>
          {backings.map((o) => (
            <Card key={o.address.toBase58()} as="article" aria-label="Accepted Backing">
              <div className="stack">
                <div className="spread">
                  <span className="row-body">
                    <span className="row-title"><PlayerName account={o.backer} /> funds your {fmtGemas(o.entry)}</span>
                    <span className="row-meta">
                      {GAME_NAMES[o.game]} · you keep {o.shareBps / 100}% of the surplus · start within {timeLeft(o.useBy, nowMs).replace(" left", "")}
                    </span>
                  </span>
                  <Chip tone="money">Funded</Chip>
                </div>
                <p className="note">
                  Their Gemas fund your entry. If you lose, they bear it and you owe nothing. If you win, their entry returns first, then you
                  keep {o.shareBps / 100}% of what remains.
                </p>
                <BackingEnter game={o.game} entry={o.entry} offer={o.address.toBase58()} />
              </div>
            </Card>
          ))}
        </section>
      )}

      {offersForMe.length > 0 && (
        <section className="stack" aria-labelledby="ofm-h">
          <Label><span id="ofm-h">Offers for your Requests</span></Label>
          {offersForMe.map((o) => (
            <Card key={o.address.toBase58()} as="article" aria-label="Offer for you">
              <div className="spread">
                <span className="row-body">
                  <span className="row-title"><PlayerName account={o.backer} /> offers to fund {fmtGemas(o.entry)}</span>
                  <span className="row-meta">
                    {GAME_NAMES[o.game]} · you keep {o.shareBps / 100}% of the surplus · {timeLeft(o.expiresAt, nowMs)}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="money"
                  disabled={busy !== null}
                  onClick={() =>
                    act("accept an Offer", `acc-${o.address.toBase58()}`, "Offer accepted. You can enter the Match now.", (s) =>
                      acceptDirected(s, new PublicKey(o.directedTo as string), o.address),
                    )
                  }
                >
                  {busy === `acc-${o.address.toBase58()}` ? "Accepting…" : "Accept"}
                </Button>
              </div>
            </Card>
          ))}
        </section>
      )}

      <div className={`bk-body${offerFor ? " with-drawer" : ""}`}>
        <div className="bk-main">
          <div className="bk-bar">
            <div className="bk-tabs" role="tablist" aria-label="Backing">
              {tabs.map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="bk-tools">
              <div className="cut cut-card bk-sort sel-host">
                <span aria-hidden="true">Sort by</span>
                <Select framed={false} aria-label="Sort by" value={sort} options={SORT_OPTIONS} onChange={setSort} />
              </div>
            </div>
          </div>

          {tab === "requests" && (
            <section aria-label="Requests" className="bk-cards">
              {loading && !board && <SkeletonCards className="rq" label="Loading Requests…" />}
              {board && others.length === 0 && (
                <Empty title="No open Requests" body="Nobody is asking to be backed right now. Post yours, or check back soon." />
              )}
              {board && others.length === 0 && myRequests.length === 0 && <BackingExample onPost={() => auth.gate("post a Request", () => setPostOpen(true))} />}
              {others.map((r) => {
                const key = r.address.toBase58();
                return (
                  <RequestCard
                    key={key}
                    id={key}
                    r={r}
                    nowMs={nowMs}
                    selected={selected === key}
                    action={
                      offeredTo.has(key) ? (
                        <Button onClick={() => setTab("mine")}>Offer sent</Button>
                      ) : awayText ? (
                        <span className="meta">{awayText}</span>
                      ) : (
                        <Button variant="money" onClick={() => auth.gate("make an Offer", () => setOfferFor(r))}>
                          Make an Offer
                        </Button>
                      )
                    }
                  />
                );
              })}
              {myRequests.map((r) => (
                <div className={`bk-span${highlight === r.address.toBase58() ? " bk-hl" : ""}`} id={`rq-${r.address.toBase58()}`} key={r.address.toBase58()}>
                  <MyRequest
                    r={r}
                    nowMs={nowMs}
                    busy={busy}
                    onCancel={() => act("cancel a Request", `cr-${r.address.toBase58()}`, "Request cancelled.", (s) => cancelRequest(s, r.address))}
                  />
                </div>
              ))}
            </section>
          )}

          {tab === "mine" && (
            <section aria-label="My Backings" className="stack">
              <Label>Offers you funded</Label>
              {board && mine.length === 0 && (
                <Empty title="No Backings yet" body="Pick a Player under Requests and make an Offer. The Player accepts or declines." />
              )}
              <div className="bk-mine">
                {mine.map((o) => (
                  <MyOffer
                    key={o.address.toBase58()}
                    offer={o}
                    requests={requestByAddress}
                    nowMs={nowMs}
                    busy={busy}
                    onCancel={() => act("cancel an Offer", `co-${o.address.toBase58()}`, "Offer cancelled. Your Gemas are released.", (s) => cancelOffer(s, o))}
                    onRelease={() => act("release Gemas", `ex-${o.address.toBase58()}`, "Expired. Your Gemas are released.", (s) => expireOffer(s, o))}
                  />
                ))}
              </div>
            </section>
          )}
        </div>

        {offerFor && (
          <OfferDrawer
            key={offerFor.address.toBase58()}
            request={offerFor}
            available={onChain ? gemas.available : null}
            nowMs={nowMs}
            busy={busy !== null}
            onClose={() => setOfferFor(null)}
            onSend={(game, entry, share, request) => {
              setOfferFor(null);
              act("make an Offer", "post-offer", "Offer sent. The Player accepts or declines.", async (s) =>
                (await postOffer(s, { game, entry, shareBps: share * 100, request: request.address }, auth.getAccessToken)).sig,
              );
            }}
          />
        )}
      </div>
      <Sheet open={postOpen} onClose={() => setPostOpen(false)} title="Post a Request">
        <PostRequest
          record={recordFromMatches(snapshot?.matches ?? [])}
          signedIn={onChain}
          busy={busy === "post-request"}
          disabled={busy !== null}
          onPost={(game, entry) => {
            setPostOpen(false);
            let existing = false;
            act(
              "post a Request",
              "post-request",
              () => (existing ? "You already have a live Request for this Game and entry. It is highlighted below." : "Request posted. Backers can answer it with Offers."),
              async (s) => {
                const live = liveRequestFor(await freshRequests(), me ?? "", game, entry);
                if (live) {
                  existing = true;
                  setTab("requests");
                  setHighlight(live.address.toBase58());
                  return undefined;
                }
                return (await postRequest(s, game, entry, auth.getAccessToken)).sig;
              },
            );
          }}
        />
      </Sheet>
    </div>
  );
}

/** Enter the Queue or Challenge under a Backing. A Trading Duel Backing asks which asset to trade first. */
function BackingEnter({ game, entry, offer }: { game: GameId; entry: number; offer: string }) {
  const [asset, setAsset] = useState<0 | 1 | 2>(0);
  const q = backingQuery(game, asset, entry, offer);
  return (
    <>
      {game === "trading-duel" && <AssetPicker value={asset} onChange={setAsset} name={`bk-asset-${offer}`} />}
      <div className="hstack wrap">
        <Button variant="money" size="sm" href={`/play/queue?${q}`}>
          Enter the Queue
        </Button>
        <Button size="sm" href={`/play/challenge?${q}`}>
          Challenge a friend
        </Button>
      </div>
    </>
  );
}

function Empty({ title, body }: { title: string; body: string }) {
  return (
    <BustCard bust="herEmpty" size={130} className="bk-empty bk-span">
      <b>{title}</b>
      <p>{body}</p>
    </BustCard>
  );
}

function PostRequest({
  record,
  signedIn,
  busy,
  disabled,
  onPost,
}: {
  record: { matches: number; wins: number };
  signedIn: boolean;
  busy: boolean;
  disabled: boolean;
  onPost: (game: GameId, entry: EntrySize) => void;
}) {
  const [game, setGame] = useState<GameId>("block-puzzle");
  const [entry, setEntry] = useState<EntrySize>(1000);
  return (
    <section aria-label="Post a Request">
      <div className="stack">
        <p className="meta">
          Ask to be backed for one Match. Backers see your real record{signedIn ? `: ${recordText(record)}` : ""}. A Request carries no
          split: Backers answer with Offers and you accept one.
        </p>
        <div className="field">
          <label className="label" htmlFor="req-game">Game</label>
          <Select id="req-game" value={game} options={GAME_OPTIONS} onChange={setGame} />
        </div>
        <EntryPicker value={entry} onChange={setEntry} legend="Entry to be backed" name="req-entry" />
        <Button block disabled={disabled} onClick={() => onPost(game, entry)}>
          {busy ? "Posting…" : "Post Request"}
        </Button>
        <p className="note">Requests expire after 24 hours.</p>
      </div>
    </section>
  );
}

function MyRequest({ r, nowMs, busy, onCancel }: { r: ChainRequest; nowMs: number; busy: string | null; onCancel: () => void }) {
  return (
    <Card as="article" aria-label="Your Request">
      <div className="spread">
        <span className="row-body">
          <span className="row-title">Your Request · {fmtGemas(r.entry)}</span>
          <span className="row-meta">
            {GAME_NAMES[r.game]} · {r.status === "accepted" ? "accepted by a Backer" : timeLeft(r.expiresAt, nowMs)}
          </span>
        </span>
        {r.status === "open" ? (
          <Button size="sm" disabled={busy !== null} onClick={onCancel}>
            {busy === `cr-${r.address.toBase58()}` ? "Cancelling…" : "Cancel"}
          </Button>
        ) : (
          <Chip tone="strong" icon={<CheckIcon />}>Accepted</Chip>
        )}
      </div>
    </Card>
  );
}

function MyOffer({
  offer,
  requests,
  nowMs,
  busy,
  onCancel,
  onRelease,
}: {
  offer: ChainOffer;
  requests: Map<string, ChainRequest>;
  nowMs: number;
  busy: string | null;
  onCancel: () => void;
  onRelease: () => void;
}) {
  const nowSecs = nowMs / 1000;
  const reserved = offer.lines.reduce((s, l) => s + Number(l.amount), 0);
  const lapsed = (offer.status === "open" && nowSecs >= offer.expiresAt) || (offer.status === "accepted" && nowSecs >= offer.useBy);
  const target = offer.directedTo ? requests.get(offer.directedTo) : null;
  const playerKey = offer.player ?? target?.player ?? null;
  const key = offer.address.toBase58();
  const status =
    offer.status === "consumed"
      ? "Match started: your Gemas are in the Pot"
      : lapsed
        ? "Expired: release your reserved Gemas"
        : offer.status === "accepted"
          ? <>Accepted by <PlayerName account={offer.player ?? ""} /> · they have {timeLeft(offer.useBy, nowMs).replace(" left", "")} to start</>
          : offer.directedTo
            ? <>Waiting for {playerKey ? <PlayerName account={playerKey} /> : "the Player"} · {timeLeft(offer.expiresAt, nowMs)}</>
            : "Offers now go to a Player's Request. Cancel this one to release your Gemas.";
  return (
    <Card as="article" aria-label="Your Offer">
      <div className="stack">
        <div className="spread">
          <span className="row-body">
            <span className="row-title">Offer · {fmtGemas(offer.entry)}</span>
            <span className="row-meta">{GAME_NAMES[offer.game]} · Player keeps {offer.shareBps / 100}% of the surplus</span>
          </span>
          {offer.status === "consumed" ? <Chip tone="money">Used</Chip> : <Chip tone="strong">{fmtGemas(reserved)} reserved</Chip>}
        </div>
        <p className="note">{status}</p>
        <div className="hstack wrap">
          {offer.status === "consumed" && offer.matchId !== null && (
            <Button size="sm" href={`/play/match/${offer.matchId.toString()}`}>See the Match</Button>
          )}
          {lapsed && (
            <Button size="sm" disabled={busy !== null} onClick={onRelease}>
              {busy === `ex-${key}` ? "Releasing…" : "Release Gemas"}
            </Button>
          )}
          {!lapsed && (offer.status === "open" || offer.status === "accepted") && (
            <Button size="sm" disabled={busy !== null} onClick={onCancel}>
              {busy === `co-${key}` ? "Cancelling…" : "Cancel Offer"}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}


/**
 * MAKE AN OFFER: a modal over the page, the Player's card (as on the board) beside the terms. The Offer
 * takes the Request's Game and entry; the Player keeps 10 to 90% of the surplus; the Offer lasts 24 hours.
 */
function OfferDrawer({
  request,
  available,
  nowMs,
  busy,
  onClose,
  onSend,
}: {
  request: ChainRequest;
  available: number | null;
  nowMs: number;
  busy: boolean;
  onClose: () => void;
  onSend: (game: GameId, entry: number, share: number, request: ChainRequest) => void;
}) {
  const { game, entry } = request;
  const [share, setShare] = useState(40);
  const win = backedSplit({ entry, ...FEES, shareBps: share * 100, won: true });
  const short = available !== null && available < entry;

  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const dismiss = () => ref.current?.close();

  return (
    <dialog
      ref={ref}
      className="cut cut-frame bk-drawer"
      aria-label="Make an Offer"
      // Close the dialog first so its exit plays, then let the page unmount it.
      onClose={() => setTimeout(onClose, 180)}
      onClick={(e) => e.target === ref.current && dismiss()}
    >
      <div className="bk-drawer-in">
        <div className="bk-drawer-head">
          <h2 className="h-section">Make an offer</h2>
          <button type="button" className="cut icon-btn" onClick={dismiss} aria-label="Close">
            <XMark aria-hidden="true" />
          </button>
        </div>
        <aside className="bk-drawer-card">
          <RequestCard r={request} nowMs={nowMs} />
        </aside>
        <div className="bk-drawer-terms">
          <Slider
            label="Player keeps"
            value={share}
            min={10}
            max={90}
            step={5}
            onChange={setShare}
            display={`${share}%`}
            format={(v) => `${v}%`}
          />
          <p className="meta bk-keep">You keep {100 - share}% of the surplus.</p>
          <table className="bk-outcomes">
            <thead>
              <tr>
                <th />
                <th scope="col">You</th>
                <th scope="col">Player</th>
              </tr>
            </thead>
            <tbody>
              <tr className="won">
                <th scope="row"><span className="bk-ico won"><CheckIcon /></span> They win</th>
                <td><b className="tnum">+{fmtGemas(win.backerSurplus)}</b><small>net · your {fmtGemas(entry)} comes back, plus {100 - share}% of the surplus</small></td>
                <td><b className="tnum">+{fmtGemas(win.playerShare)}</b><small>{share}% of the surplus</small></td>
              </tr>
              <tr className="lost">
                <th scope="row"><span className="bk-ico lost"><XIcon /></span> They lose</th>
                <td><b className="tnum">−{fmtGemas(entry)}</b><small>you lose your entry</small></td>
                <td><b className="tnum">0</b><small>never owe anything</small></td>
              </tr>
            </tbody>
          </table>
          <p className="meta">
            On a win the Pot is {fmtGemas(entry * 2)} Gemas; {fmtGemas(win.fees)} go to Fees. A Backing cannot be revoked once the Match starts.
          </p>

          {short && (
            <p className="status err" role="alert">
              You have {fmtGemas(available)} Gemas available. <Link href="/vault">Get Gemas in your Vault</Link>
            </p>
          )}
          <footer className="bk-drawer-foot">
            <div className="bk-reserve">
              <span className="label">You reserve</span>
              <b><GemaMark size={22} glint /> {fmtGemas(entry)}</b>
              <span className="meta">for 24 hours</span>
            </div>
            <div className="bk-drawer-actions">
              <span className="bk-cancel"><Button onClick={dismiss}>Cancel</Button></span>
              <Button variant="money" disabled={short || busy} onClick={() => onSend(game, entry, share, request)}>
                <GemasLabel action="Make an Offer" gemas={entry} />
              </Button>
            </div>
          </footer>
        </div>
      </div>
    </dialog>
  );
}
