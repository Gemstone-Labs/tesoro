"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { Trophy, X as XMark } from "lucide-react";
import {
  AssetPicker,
  Button,
  Card,
  CheckIcon,
  BustCard,
  Chip,
  EntryPicker,
  GemaAmount,
  GemaMark,
  Label,
  Sheet,
  SkeletonCards,
  Slider,
} from "@/components/ui";
import { AccountLink } from "@/components/account/AccountLink";
import { PlayerAvatar, PlayerName, usePlayerLabel } from "@/components/account/Player";
import { useGuideTip } from "@/components/guide/Guide";
import { useAccount } from "@/lib/account";
import { art } from "@/lib/art";
import {
  acceptApplicant,
  acceptDirected,
  applyToOffer,
  cancelOffer,
  cancelRequest,
  expireOffer,
  postOffer,
  postRequest,
  type ChainOffer,
  type ChainRequest,
  type PlayerRecord,
} from "@/lib/chain/backing";
import { EntryError, MAX_ENTRY_SOURCES } from "@/lib/chain/ledger";
import { recordFromMatches, recordShort, recordText, timeLeft, useBackingBoard } from "@/lib/chain/useBackingBoard";
import { fmtGemas } from "@/lib/format";
import { backingQuery } from "@/lib/game-params";
import { GAME_NAMES } from "@/lib/mock";
import type { EntrySize, GameId } from "@/lib/mock";
import { RequestCard } from "@/components/backing/RequestCard";
import { BackingExample } from "./BackingExample";
import "./backing.css";
import { plainError } from "@/lib/errors";

const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

type Tab = "requests" | "public" | "mine";
type Sort = "recent" | "entry" | "record";

const winRate = (r: PlayerRecord) => (r.matches === 0 ? 0 : r.wins / r.matches);

function explain(e: unknown): string {
  if (e instanceof EntryError) {
    return e.code === "insufficient"
      ? "Not enough available Gemas. Gemas reserved for your other Offers cannot be reserved again."
      : `This entry would draw on more than ${MAX_ENTRY_SOURCES} Sources. Redeem a few small balances in your Wallet first.`;
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
  const nowMs = useNow();
  const nowSecs = Math.floor(nowMs / 1000);
  const me = snapshot?.accountKey.toBase58() ?? null;
  const [offerFor, setOfferFor] = useState<ChainRequest | "public" | null>(null);
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
  const liveMine = myRequests.filter((r) => r.live);
  const backings = offers.filter((o) => o.status === "accepted" && o.player === me && nowSecs < o.useBy);
  const offersForMe = offers.filter(
    (o) => o.status === "open" && nowSecs < o.expiresAt && o.directedTo && myRequests.some((r) => r.live && r.address.toBase58() === o.directedTo),
  );
  const sorted = <T extends { entry: number; expiresAt: number }>(xs: T[], rec: (x: T) => PlayerRecord | null) =>
    [...xs].sort((a, b) =>
      sort === "entry" ? b.entry - a.entry : sort === "record" ? winRate(rec(b) ?? { matches: 0, wins: 0 }) - winRate(rec(a) ?? { matches: 0, wins: 0 }) : b.expiresAt - a.expiresAt,
    );
  const others = sorted(
    requests.filter((r) => r.live && r.player !== me),
    (r) => r.record,
  );
  const publicOffers = sorted(
    offers.filter((o) => o.status === "open" && nowSecs < o.expiresAt && !o.directedTo && o.backer !== me),
    () => null,
  );
  const mine = offers.filter((o) => o.backer === me && ["open", "accepted", "consumed"].includes(o.status));
  const offeredTo = new Set(mine.filter((o) => o.status === "open" && nowSecs < o.expiresAt && o.directedTo).map((o) => o.directedTo));

  const run = (key: string, label: string, fn: () => Promise<string | undefined>) => {
    setBusy(key);
    setError(null);
    setDone(null);
    void (async () => {
      try {
        const sig = await fn();
        setDone({ text: label, sig });
        await Promise.all([refresh(), refreshAccount()]);
      } catch (e) {
        setError(explain(e));
      } finally {
        setBusy(null);
      }
    })();
  };
  const act = (reason: string, key: string, label: string, fn: (s: NonNullable<typeof auth.signer>) => Promise<string | undefined>) =>
    auth.gate(reason, () =>
      run(key, label, async () => {
        if (!auth.signer) throw new Error("Your wallet is not ready yet. Try again in a moment.");
        return fn(auth.signer);
      }),
    );

  const apply = (offer: ChainOffer) =>
    act("apply to an Offer", `apply-${offer.address.toBase58()}`, "Applied. The Backer chooses whom to back.", async (signer) => {
      let request = liveMine.find(
        (r) => r.game === offer.game && r.entry === offer.entry && !offer.applicants.includes(r.address.toBase58()),
      )?.address;
      if (!request) request = (await postRequest(signer, offer.game, offer.entry, auth.getAccessToken)).address;
      return applyToOffer(signer, request, offer.address);
    });

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

  const selected = offerFor && offerFor !== "public" ? offerFor.address.toBase58() : null;
  const tabs: [Tab, string][] = [
    ["requests", "Requests"],
    ["public", "Public Offers"],
    ["mine", "My Backings"],
  ];

  return (
    <div className="bk">
      <header className="page-head">
        <div>
          <h1 className="page-title">Back a player</h1>
          <p className="page-sub">
            Support skilled players and share their success.
            {onChain && me && (
              <>
                {" "}
                <span className="bk-avail">Available to back <GemaAmount value={gemas.available} size="sm" />{gemas.reserved > 0 ? ` · ${fmtGemas(gemas.reserved)} reserved` : ""}</span>
              </>
            )}
          </p>
        </div>
        <Button onClick={() => auth.gate("post a Request", () => setPostOpen(true))}>Post a Request</Button>
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
              <label className="cut cut-card bk-sort">
                <span>Sort by</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
                  <option value="recent">Recent</option>
                  <option value="entry">Entry</option>
                  <option value="record">Win rate</option>
                </select>
              </label>
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
                <div className="bk-span" key={r.address.toBase58()}>
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

          {tab === "public" && (
            <section aria-label="Public Offers" className="bk-cards">
              {board && publicOffers.length === 0 && (
                <Empty title="No public Offers" body="No Backer has a public Offer open right now. Post a Request and Backers can answer it." />
              )}
              {publicOffers.map((o) => {
                const applied = liveMine.some((r) => o.applicants.includes(r.address.toBase58()));
                const key = `apply-${o.address.toBase58()}`;
                return (
                  <ArtCard
                    key={o.address.toBase58()}
                    seed={o.backer}
                    game={o.game}
                    line={`Player keeps ${o.shareBps / 100}% · ${timeLeft(o.expiresAt, nowMs)}`}
                    label="Offered entry"
                    entry={o.entry}
                    action={
                      applied ? (
                        <Chip tone="strong" icon={<CheckIcon />}>Applied</Chip>
                      ) : (
                        <Button variant="money" disabled={busy !== null} onClick={() => apply(o)}>
                          {busy === key ? "Applying…" : "Apply"}
                        </Button>
                      )
                    }
                  />
                );
              })}
            </section>
          )}

          {tab === "mine" && (
            <section aria-label="My Backings" className="stack">
              <div className="section-head">
                <Label>Offers you funded</Label>
                <Button size="sm" variant="money" onClick={() => auth.gate("post an Offer", () => setOfferFor("public"))}>
                  New public Offer
                </Button>
              </div>
              {board && mine.length === 0 && (
                <Empty title="No Backings yet" body="Answer a Request with an Offer, or post a public Offer and choose whom to back." />
              )}
              <div className="bk-mine">
                {mine.map((o) => (
                  <MyOffer
                    key={o.address.toBase58()}
                    offer={o}
                    requests={requestByAddress}
                    nowMs={nowMs}
                    busy={busy}
                    onAccept={(r) =>
                      act("accept a Player", `pick-${r.address.toBase58()}`, "Player accepted. They can now enter the Match.", (s) => acceptApplicant(s, r.address, o.address))
                    }
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
            key={offerFor === "public" ? "public" : offerFor.address.toBase58()}
            target={offerFor}
            available={onChain ? gemas.available : null}
            busy={busy !== null}
            onClose={() => setOfferFor(null)}
            onSend={(game, entry, share, request) => {
              setOfferFor(null);
              act(request ? "make an Offer" : "post an Offer", "post-offer", request ? "Offer sent. The Player accepts or declines." : "Public Offer posted.", async (s) =>
                (await postOffer(s, { game, entry, shareBps: share * 100, request: request?.address }, auth.getAccessToken)).sig,
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
            act("post a Request", "post-request", "Request posted. Backers can answer it with Offers.", async (s) => (await postRequest(s, game, entry, auth.getAccessToken)).sig);
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

/** A Player or Backer card: avatar, handle, game, record line, a game art strip, the entry and one action. With `account`, the avatar and name lead to that Player's Account. */
function ArtCard({
  seed,
  account,
  game,
  line,
  label,
  entry,
  action,
  selected = false,
  id,
}: {
  seed: string;
  account?: string;
  game: GameId;
  line: string;
  label: string;
  entry: number;
  action: ReactNode;
  selected?: boolean;
  id?: string;
}) {
  const name = usePlayerLabel(seed);
  return (
    <article id={id} className={`cut cut-card bk-card${selected ? " selected" : ""}`} aria-label={`${name}, ${GAME_NAMES[game]}`}>
      {account ? (
        <AccountLink account={account} decorative className="cut cut-btn avatar bk-avatar">
          <PlayerAvatar account={seed} size={78} />
        </AccountLink>
      ) : (
        <span className="cut cut-btn avatar bk-avatar">
          <PlayerAvatar account={seed} size={78} />
        </span>
      )}
      <div className="bk-who">
        <strong>{account ? <AccountLink account={account} /> : <PlayerName account={seed} />}</strong>
        <span>{GAME_NAMES[game]}</span>
        <span className="bk-rec">{line}</span>
      </div>
      <div className="bk-foot">
        <div>
          <span>{label}</span>
          <b>
            <GemaMark size={24} /> {fmtGemas(entry)} <small>Gemas</small>
          </b>
        </div>
        {action}
      </div>
    </article>
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
          <select id="req-game" className="cut cut-chip select" value={game} onChange={(e) => setGame(e.target.value as GameId)}>
            <option value="block-puzzle">{GAME_NAMES["block-puzzle"]}</option>
            <option value="holdem">{GAME_NAMES.holdem}</option>
            <option value="trading-duel">{GAME_NAMES["trading-duel"]}</option>
          </select>
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
  onAccept,
  onCancel,
  onRelease,
}: {
  offer: ChainOffer;
  requests: Map<string, ChainRequest>;
  nowMs: number;
  busy: string | null;
  onAccept: (r: ChainRequest) => void;
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
            : `Public · ${offer.applicants.length} applicant${offer.applicants.length === 1 ? "" : "s"} · ${timeLeft(offer.expiresAt, nowMs)}`;
  return (
    <Card as="article" aria-label={offer.directedTo ? "Your directed Offer" : "Your public Offer"}>
      <div className="stack">
        <div className="spread">
          <span className="row-body">
            <span className="row-title">{offer.directedTo ? "Offer" : "Public Offer"} · {fmtGemas(offer.entry)}</span>
            <span className="row-meta">{GAME_NAMES[offer.game]} · Player keeps {offer.shareBps / 100}% of the surplus</span>
          </span>
          {offer.status === "consumed" ? <Chip tone="money">Used</Chip> : <Chip tone="strong">{fmtGemas(reserved)} reserved</Chip>}
        </div>
        <p className="note">{status}</p>
        {offer.status === "open" && !lapsed && !offer.directedTo && offer.applicants.length > 0 && (
          <div className="stack">
            <Label>Applicants ({offer.applicants.length})</Label>
            {offer.applicants.map((a) => {
              const r = requests.get(a);
              if (!r) return null;
              return (
                <div className="spread" key={a}>
                  <span className="row-body">
                    <span className="row-title">
                      <AccountLink account={r.player} newTab />
                    </span>
                    <span className="row-meta">{recordText(r.record)}</span>
                  </span>
                  <Button size="sm" variant="money" disabled={busy !== null || !r.live} onClick={() => onAccept(r)}>
                    {busy === `pick-${a}` ? "Accepting…" : "Accept"}
                  </Button>
                </div>
              );
            })}
            <p className="note">You choose whom to back. Once the Match starts, a Backing cannot be revoked.</p>
          </div>
        )}
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


/** MAKE AN OFFER: a right-hand drawer on desktop, a bottom sheet below 1024px. Same terms as before: 24-hour Offer, Player's share 10 to 90%. */
function OfferDrawer({
  target,
  available,
  busy,
  onClose,
  onSend,
}: {
  target: ChainRequest | "public";
  available: number | null;
  busy: boolean;
  onClose: () => void;
  onSend: (game: GameId, entry: EntrySize, share: number, request: ChainRequest | null) => void;
}) {
  const isPublic = target === "public";
  const [game, setGame] = useState<GameId>(isPublic ? "block-puzzle" : target.game);
  const [entry, setEntry] = useState<EntrySize>(isPublic ? 1000 : (target.entry as EntrySize));
  const [share, setShare] = useState(40);
  const short = available !== null && available < entry;
  const request = isPublic ? null : target;
  const player = request?.player ?? null;

  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className="cut cut-frame bk-drawer"
      aria-label={isPublic ? "New public Offer" : "Make an Offer"}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
    >
      <div className="bk-drawer-in">
        <div className="bk-drawer-head">
          <h2 className="h-section">{isPublic ? "New public offer" : "Make an offer"}</h2>
          <button type="button" className="cut icon-btn" onClick={onClose} aria-label="Close">
            <XMark aria-hidden="true" />
          </button>
        </div>

        <div className="bk-drawer-grid">
          <div className="bk-drawer-form">
            {player ? (
              <div className="bk-summary">
                <div className="cut cut-card bk-summary-who">
                  <span className="cut cut-btn avatar bk-avatar">
                    <PlayerAvatar account={player} size={78} />
                  </span>
                  <div className="bk-who">
                    <strong>
                      <AccountLink account={player} newTab />
                    </strong>
                    <span>{GAME_NAMES[game]}</span>
                    <span className="bk-rec">{recordShort(request!.record)}</span>
                  </div>
                </div>
                <div className="bk-summary-art" aria-hidden="true">
                  <Image src={art.thumb[game]} alt="" width={200} height={200} />
                </div>
              </div>
            ) : (
              <div className="stack">
                <p className="meta">Post terms; Players apply and you accept one.</p>
                <div className="field">
                  <label className="label" htmlFor="off-game">Game</label>
                  <select id="off-game" className="cut cut-chip select" value={game} onChange={(e) => setGame(e.target.value as GameId)}>
                    <option value="block-puzzle">{GAME_NAMES["block-puzzle"]}</option>
                    <option value="holdem">{GAME_NAMES.holdem}</option>
                    <option value="trading-duel">{GAME_NAMES["trading-duel"]}</option>
                  </select>
                </div>
                <EntryPicker value={entry} onChange={setEntry} legend="Entry you fund" name="off-entry" />
              </div>
            )}

            {player && (
              <div className="cut cut-card bk-entry">
                <span>Entry amount</span>
                <b>
                  <GemaMark size={30} /> {fmtGemas(entry)} <small>Gemas</small>
                </b>
              </div>
            )}

            <Slider
              label="Player's share of the surplus"
              value={share}
              min={10}
              max={90}
              step={5}
              onChange={setShare}
              display={`${share}%`}
              minLabel="10%"
              maxLabel="90%"
            />
            <div className="bk-split">
              <div className="cut cut-card">
                <span>You (Backer)</span>
                <b>{100 - share}%</b>
                <small>of surplus</small>
              </div>
              <div className="cut cut-card">
                <span>Player{player ? <> (<PlayerName account={player} />)</> : ""}</span>
                <b>{share}%</b>
                <small>of surplus</small>
              </div>
            </div>

            <div className="cut cut-card bk-explain">
              <div>
                <Trophy aria-hidden="true" />
                <p>
                  <b>If they win:</b> your {fmtGemas(entry)} back first, then you keep {100 - share}% of the surplus.
                </p>
              </div>
              <div>
                <span className="bk-x" aria-hidden="true"><XMark /></span>
                <p>
                  <b>If they lose:</b> you lose {fmtGemas(entry)}. They never owe anything.
                </p>
              </div>
            </div>

            {short && (
              <p className="status err" role="alert">
                You have {fmtGemas(available)} Gemas available. <Link href="/wallet">Get Gemas in your Wallet</Link>
              </p>
            )}
            <p className="note">You reserve {fmtGemas(entry)} Gemas. The Offer lasts 24 hours. A Backing cannot be revoked once the Match starts.</p>
            <div className="bk-drawer-actions">
              <Button onClick={onClose}>Cancel</Button>
              <Button variant="money" disabled={short || busy} onClick={() => onSend(game, entry, share, isPublic ? null : target)}>
                {isPublic ? "Post Offer" : "Make an Offer"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
}
