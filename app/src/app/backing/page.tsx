"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  Button,
  Card,
  CheckIcon,
  Chip,
  EntryPicker,
  GemaAmount,
  Label,
  Row,
  Sheet,
  Slider,
  Thumb,
} from "@/components/ui";
import { useAccount } from "@/lib/account";
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
} from "@/lib/chain/backing";
import { EntryError, MAX_ENTRY_SOURCES } from "@/lib/chain/ledger";
import { recordFromMatches, recordText, shortKey, timeLeft, useBackingBoard } from "@/lib/chain/useBackingBoard";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import type { EntrySize, GameId } from "@/lib/mock";

const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

function explain(e: unknown): string {
  if (e instanceof EntryError) {
    return e.code === "insufficient"
      ? "Not enough available Gemas. Gemas reserved for your other Offers cannot be reserved again."
      : `This entry would draw on more than ${MAX_ENTRY_SOURCES} Sources. Redeem a few small balances in your Wallet first.`;
  }
  const first = e instanceof Error ? e.message.split("\n")[0] : String(e);
  return first.length > 160 ? `${first.slice(0, 160)}…` : first;
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
  const nowMs = useNow();
  const nowSecs = Math.floor(nowMs / 1000);
  const me = snapshot?.accountKey.toBase58() ?? null;
  const [offerFor, setOfferFor] = useState<ChainRequest | "public" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; sig?: string } | null>(null);

  const requests = board?.requests ?? [];
  const offers = board?.offers ?? [];
  const requestByAddress = new Map(requests.map((r) => [r.address.toBase58(), r]));

  const pending = (r: ChainRequest) => offers.some((o) => o.status === "accepted" && o.request === r.address.toBase58());
  const myRequests = requests.filter((r) => r.player === me && (r.live || (r.status === "accepted" && pending(r))));
  const liveMine = myRequests.filter((r) => r.live);
  const others = requests.filter((r) => r.live && r.player !== me);
  const backings = offers.filter((o) => o.status === "accepted" && o.player === me && nowSecs < o.useBy);
  const offersForMe = offers.filter(
    (o) => o.status === "open" && nowSecs < o.expiresAt && o.directedTo && myRequests.some((r) => r.live && r.address.toBase58() === o.directedTo),
  );
  const publicOffers = offers.filter((o) => o.status === "open" && nowSecs < o.expiresAt && !o.directedTo && o.backer !== me);
  const mine = offers.filter((o) => o.backer === me && ["open", "accepted", "consumed"].includes(o.status));

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

  return (
    <div className="stack-lg">
      <h1 className="page-title">Backing</h1>
      {onChain && me && (
        <Card as="section" aria-label="Your Gemas and reservations">
          <dl className="kv">
            <dt>Gemas in your Wallet</dt>
            <dd><GemaAmount value={gemas.total} size="sm" /></dd>
            <dt>Reserved for your Offers</dt>
            <dd><GemaAmount value={gemas.reserved} size="sm" /></dd>
            <dt>Available now</dt>
            <dd><GemaAmount value={gemas.available} size="sm" /></dd>
          </dl>
          <p className="note" style={{ marginTop: 8 }}>
            Reserved Gemas stay yours. They return when the Offer is cancelled or expires (24 hours), and go into the Pot when the backed Player starts the Match.
          </p>
        </Card>
      )}

      {error && <p className="status err" role="alert">{error}</p>}
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
      {loadError && !board && <p className="status err" role="alert">Could not read Backing from Solana devnet: {loadError}</p>}

      {backings.length > 0 && (
        <section className="stack" aria-labelledby="bk-h">
          <Label><span id="bk-h">Your Backings: ready to play</span></Label>
          {backings.map((o) => (
            <Card key={o.address.toBase58()} as="article" aria-label="Accepted Backing">
              <div className="stack">
                <div className="spread">
                  <span className="row-body">
                    <span className="row-title">{shortKey(o.backer)} funds your {fmtGemas(o.entry)}</span>
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
                <div className="hstack wrap">
                  <Button variant="money" size="sm" href={`/play/queue?game=${o.game}&entry=${o.entry}&backing=${o.address.toBase58()}`}>
                    Enter the Queue
                  </Button>
                  <Button size="sm" href={`/play/challenge?game=${o.game}&entry=${o.entry}&backing=${o.address.toBase58()}`}>
                    Challenge a friend
                  </Button>
                </div>
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
                  <span className="row-title">{shortKey(o.backer)} offers to fund {fmtGemas(o.entry)}</span>
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

      <div className="cols cols-eq">
        <section className="stack" aria-labelledby="req-h">
          <Label><span id="req-h">Requests</span></Label>
          {loading && !board && <p className="meta">Reading Requests from Solana devnet…</p>}
          {board && others.length === 0 && <p className="meta">No open Requests. Post yours below, or check back soon.</p>}
          {others.map((r) => (
            <div key={r.address.toBase58()} id={r.address.toBase58()} style={{ scrollMarginTop: 80 }}>
              <Row
                thumb={<Thumb>{r.player[0]}</Thumb>}
                title={`${shortKey(r.player)} asks for ${fmtGemas(r.entry)}`}
                meta={`${GAME_NAMES[r.game]} · ${recordText(r.record)} · ${timeLeft(r.expiresAt, nowMs)}`}
                cta="Make an Offer"
                ctaTone="money"
                onClick={() => auth.gate("make an Offer", () => setOfferFor(r))}
              />
            </div>
          ))}
          {myRequests.map((r) => (
            <MyRequest
              key={r.address.toBase58()}
              r={r}
              nowMs={nowMs}
              busy={busy}
              onCancel={() => act("cancel a Request", `cr-${r.address.toBase58()}`, "Request cancelled.", (s) => cancelRequest(s, r.address))}
            />
          ))}
          <PostRequest
            record={recordFromMatches(snapshot?.matches ?? [])}
            signedIn={onChain}
            busy={busy === "post-request"}
            disabled={busy !== null}
            onPost={(game, entry) =>
              act("post a Request", "post-request", "Request posted. Backers can answer it with Offers.", async (s) => (await postRequest(s, game, entry, auth.getAccessToken)).sig)
            }
          />
        </section>

        <div className="stack-lg">
          <section className="stack" aria-labelledby="pub-h">
            <Label><span id="pub-h">Public Offers</span></Label>
            {board && publicOffers.length === 0 && <p className="meta">No public Offers open right now.</p>}
            {publicOffers.map((o) => {
              const applied = liveMine.some((r) => o.applicants.includes(r.address.toBase58()));
              const key = `apply-${o.address.toBase58()}`;
              return (
                <Card key={o.address.toBase58()} as="article" aria-label={`Offer by ${shortKey(o.backer)}`}>
                  <div className="spread">
                    <span className="row-body">
                      <span className="row-title">{shortKey(o.backer)} backs {fmtGemas(o.entry)}</span>
                      <span className="row-meta">
                        {GAME_NAMES[o.game]} · you keep {o.shareBps / 100}% of the surplus · {timeLeft(o.expiresAt, nowMs)}
                      </span>
                    </span>
                    {applied ? (
                      <Chip tone="strong" icon={<CheckIcon />}>Applied</Chip>
                    ) : (
                      <Button size="sm" disabled={busy !== null} onClick={() => apply(o)}>
                        {busy === key ? "Applying…" : "Apply"}
                      </Button>
                    )}
                  </div>
                </Card>
              );
            })}
          </section>

          <section className="stack" aria-labelledby="mine-h">
            <div className="section-head">
              <Label><span id="mine-h">Your Offers</span></Label>
              <Button size="sm" variant="money" onClick={() => auth.gate("post an Offer", () => setOfferFor("public"))}>
                New public Offer
              </Button>
            </div>
            {board && mine.length === 0 && <p className="meta">You have no Offers. Answer a Request or post a public Offer.</p>}
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
          </section>
        </div>
      </div>

      <OfferSheet
        target={offerFor}
        available={onChain ? gemas.available : null}
        onClose={() => setOfferFor(null)}
        onSend={(game, entry, share, request) => {
          setOfferFor(null);
          act(request ? "make an Offer" : "post an Offer", "post-offer", request ? "Offer sent. The Player accepts or declines." : "Public Offer posted.", async (s) =>
            (await postOffer(s, { game, entry, shareBps: share * 100, request: request?.address }, auth.getAccessToken)).sig,
          );
        }}
      />
      <p className="note">Solana devnet · Gemas come from a simulated Position · Requests and Offers expire after 24 hours.</p>
    </div>
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
    <Card large as="section" aria-label="Post a Request">
      <div className="stack">
        <Label>Post a Request</Label>
        <p className="meta">
          Ask to be backed for one Match. Backers see your real record{signedIn ? `: ${recordText(record)}` : ""}. A Request carries no
          split: Backers answer with Offers and you accept one.
        </p>
        <div className="field">
          <label className="label" htmlFor="req-game">Game</label>
          <select id="req-game" className="cut cut-chip select" value={game} onChange={(e) => setGame(e.target.value as GameId)}>
            <option value="block-puzzle">{GAME_NAMES["block-puzzle"]}</option>
            <option value="holdem">{GAME_NAMES.holdem}</option>
          </select>
        </div>
        <EntryPicker value={entry} onChange={setEntry} legend="Entry to be backed" name="req-entry" />
        <Button block disabled={disabled} onClick={() => onPost(game, entry)}>
          {busy ? "Posting…" : "Post Request"}
        </Button>
      </div>
    </Card>
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
          ? `Accepted by ${shortKey(offer.player ?? "")} · they have ${timeLeft(offer.useBy, nowMs).replace(" left", "")} to start`
          : offer.directedTo
            ? `Waiting for ${playerKey ? shortKey(playerKey) : "the Player"} · ${timeLeft(offer.expiresAt, nowMs)}`
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
                    <span className="row-title">{shortKey(r.player)}</span>
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

function OfferSheet({
  target,
  available,
  onClose,
  onSend,
}: {
  target: ChainRequest | "public" | null;
  available: number | null;
  onClose: () => void;
  onSend: (game: GameId, entry: EntrySize, share: number, request: ChainRequest | null) => void;
}) {
  return (
    <Sheet open={target !== null} onClose={onClose} title={target === "public" ? "New public Offer" : "Make an Offer"}>
      {target && (
        <OfferForm
          key={target === "public" ? "public" : target.address.toBase58()}
          target={target}
          available={available}
          onSend={onSend}
        />
      )}
    </Sheet>
  );
}

function OfferForm({
  target,
  available,
  onSend,
}: {
  target: ChainRequest | "public";
  available: number | null;
  onSend: (game: GameId, entry: EntrySize, share: number, request: ChainRequest | null) => void;
}) {
  const isPublic = target === "public";
  const [game, setGame] = useState<GameId>(isPublic ? "block-puzzle" : target.game);
  const [entry, setEntry] = useState<EntrySize>(isPublic ? 1000 : (target.entry as EntrySize));
  const [share, setShare] = useState(40);
  const short = available !== null && available < entry;

  return (
    <>
      <p className="meta">
        {isPublic
          ? "Post terms; Players apply and you accept one."
          : `${shortKey(target.player)} · ${recordText(target.record)}. They accept or decline your terms.`}
      </p>
      {isPublic && (
        <div className="field">
          <label className="label" htmlFor="off-game">Game</label>
          <select id="off-game" className="cut cut-chip select" value={game} onChange={(e) => setGame(e.target.value as GameId)}>
            <option value="block-puzzle">{GAME_NAMES["block-puzzle"]}</option>
            <option value="holdem">{GAME_NAMES.holdem}</option>
          </select>
        </div>
      )}
      {isPublic ? (
        <EntryPicker value={entry} onChange={setEntry} legend="Entry you fund" name="off-entry" />
      ) : (
        <dl className="kv">
          <dt>{GAME_NAMES[game]}</dt>
          <dd><GemaAmount value={entry} size="md" /> entry</dd>
        </dl>
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
      <dl className="kv">
        <dt>You reserve</dt>
        <dd><GemaAmount value={entry} size="md" /></dd>
        <dt>On a win</dt>
        <dd>Your entry returns first</dd>
        <dt>Then per 100 Gemas of surplus</dt>
        <dd>Player {share} · you {100 - share}</dd>
        <dt>On a loss</dt>
        <dd>You bear it; Player owes nothing</dd>
      </dl>
      {short && (
        <p className="status err" role="alert">
          You have {fmtGemas(available)} Gemas available. <Link href="/wallet">Get Gemas in your Wallet</Link>
        </p>
      )}
      <p className="note">The Offer lasts 24 hours. A Backing cannot be revoked once the Match starts.</p>
      <Button variant="money" block disabled={short} onClick={() => onSend(game, entry, share, isPublic ? null : target)}>
        {isPublic ? "Post Offer" : "Send Offer"} · reserve {fmtGemas(entry)}
      </Button>
    </>
  );
}
