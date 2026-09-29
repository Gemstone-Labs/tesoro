"use client";

import { useState } from "react";
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
import { useAccount, useBacking } from "@/lib/account";
import { fmtGemas } from "@/lib/format";
import { GAME_NAMES } from "@/lib/mock";
import type { EntrySize, GameId, Offer, PlayerRecord, Request } from "@/lib/mock";

const record = (p: PlayerRecord) => `${p.matches} Matches · ${Math.round(p.winRate * 100)}% won`;

export default function Backing() {
  const { requests, offers } = useBacking();
  const { auth } = useAccount();
  const [offerFor, setOfferFor] = useState<Request | "public" | null>(null);
  const publicOffers = offers.filter((o) => o.requestId === null && o.backer !== "You");
  const mine = offers.filter((o) => o.backer === "You");

  return (
    <div className="stack-lg">
      <h1 className="page-title">Backing</h1>
      <div className="cols cols-eq">
        <section className="stack" aria-labelledby="req-h">
          <Label><span id="req-h">Requests</span></Label>
          {requests.map((r) => (
            <div key={r.id} id={r.id} style={{ scrollMarginTop: 80 }}>
              <Row
                thumb={<Thumb>{r.player.name[0]}</Thumb>}
                title={`${r.player.name} asks for ${fmtGemas(r.entry)}`}
                meta={`${GAME_NAMES[r.game]} · ${record(r.player)}`}
                cta="Make an Offer"
                ctaTone="money"
                onClick={() => auth.gate("make an Offer", () => setOfferFor(r))}
              />
            </div>
          ))}
          <PostRequest />
        </section>

        <div className="stack-lg">
          <section className="stack" aria-labelledby="pub-h">
            <Label><span id="pub-h">Public Offers</span></Label>
            {publicOffers.map((o) => (
              <ApplyRow key={o.id} offer={o} />
            ))}
          </section>

          <section className="stack" aria-labelledby="mine-h">
            <div className="section-head">
              <Label><span id="mine-h">Your Offers</span></Label>
              <Button size="sm" variant="money" onClick={() => auth.gate("post an Offer", () => setOfferFor("public"))}>New public Offer</Button>
            </div>
            {mine.map((o) => (
              <MyOffer key={o.id} offer={o} />
            ))}
          </section>
        </div>
      </div>

      <OfferSheet target={offerFor} onClose={() => setOfferFor(null)} />
    </div>
  );
}

function PostRequest() {
  const [game, setGame] = useState<GameId>("block-puzzle");
  const [entry, setEntry] = useState<EntrySize>(1000);
  const [posted, setPosted] = useState(false);
  return (
    <Card large as="section" aria-label="Post a Request">
      <div className="stack">
        <Label>Post a Request</Label>
        <p className="meta">
          Ask to be backed for one Match. Your real Match history is shown. A Request carries no split: Backers answer with
          Offers and you accept one.
        </p>
        <div className="field">
          <label className="label" htmlFor="req-game">Game</label>
          <select id="req-game" className="cut cut-chip select" value={game} onChange={(e) => setGame(e.target.value as GameId)}>
            <option value="block-puzzle">{GAME_NAMES["block-puzzle"]}</option>
            <option value="holdem">{GAME_NAMES.holdem}</option>
          </select>
        </div>
        <EntryPicker value={entry} onChange={(v) => { setEntry(v); setPosted(false); }} legend="Entry to be backed" name="req-entry" />
        {posted ? (
          <div className="status ok" role="status"><CheckIcon /> Request posted (simulated)</div>
        ) : (
          <Button block onClick={() => setPosted(true)}>Post Request</Button>
        )}
      </div>
    </Card>
  );
}

function ApplyRow({ offer }: { offer: Offer }) {
  const [applied, setApplied] = useState(false);
  return (
    <Card as="article" aria-label={`Offer by ${offer.backer}`}>
      <div className="spread">
        <span className="row-body">
          <span className="row-title">{offer.backer} backs {fmtGemas(offer.entry)}</span>
          <span className="row-meta">{GAME_NAMES[offer.game]} · you keep {offer.playerShare}% of the surplus</span>
        </span>
        {applied ? (
          <Chip tone="strong" icon={<CheckIcon />}>Applied</Chip>
        ) : (
          <Button size="sm" onClick={() => setApplied(true)}>Apply</Button>
        )}
      </div>
    </Card>
  );
}

function MyOffer({ offer }: { offer: Offer }) {
  const [accepted, setAccepted] = useState<string | null>(null);
  return (
    <Card as="article" aria-label="Your public Offer">
      <div className="stack">
        <div className="row-body">
          <span className="row-title">Public Offer · {fmtGemas(offer.entry)}</span>
          <span className="row-meta">{GAME_NAMES[offer.game]} · Player keeps {offer.playerShare}% of the surplus</span>
        </div>
        <Label>Applicants ({offer.applicants.length})</Label>
        {offer.applicants.map((a) => (
          <div className="spread" key={a.id}>
            <span className="row-body">
              <span className="row-title">{a.name}</span>
              <span className="row-meta">{record(a)}</span>
            </span>
            {accepted === a.id ? (
              <Chip tone="money" icon={<CheckIcon />}>Accepted</Chip>
            ) : (
              <Button size="sm" variant="money" disabled={accepted !== null} onClick={() => setAccepted(a.id)}>
                Accept
              </Button>
            )}
          </div>
        ))}
        <p className="note">You choose whom to back. Once the Match starts, a Backing cannot be revoked.</p>
      </div>
    </Card>
  );
}

function OfferSheet({ target, onClose }: { target: Request | "public" | null; onClose: () => void }) {
  return (
    <Sheet open={target !== null} onClose={onClose} title={target === "public" ? "New public Offer" : "Make an Offer"}>
      {target && <OfferForm key={target === "public" ? "public" : target.id} target={target} onClose={onClose} />}
    </Sheet>
  );
}

function OfferForm({ target, onClose }: { target: Request | "public"; onClose: () => void }) {
  const isPublic = target === "public";
  const [game, setGame] = useState<GameId>(isPublic ? "block-puzzle" : target.game);
  const [entry, setEntry] = useState<EntrySize>(isPublic ? 1000 : target.entry);
  const [share, setShare] = useState(40);
  const [sent, setSent] = useState(false);

  return (
    <>
      <p className="meta">
        {isPublic
          ? "Post terms; Players apply and you accept one."
          : `${target.player.name} · ${record(target.player)}. They accept or decline your terms.`}
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
        <dt>You fund</dt>
        <dd><GemaAmount value={entry} size="md" /></dd>
        <dt>On a win</dt>
        <dd>Your entry returns first</dd>
        <dt>Then per 100 Gemas of surplus</dt>
        <dd>Player {share} · you {100 - share}</dd>
        <dt>On a loss</dt>
        <dd>You bear it; Player owes nothing</dd>
      </dl>
      <p className="note">A Backing cannot be revoked once the Match starts.</p>
      {sent ? (
        <>
          <div className="status ok" role="status"><CheckIcon /> Offer sent (simulated)</div>
          <Button block onClick={onClose}>Done</Button>
        </>
      ) : (
        <Button variant="money" block onClick={() => setSent(true)}>
          {isPublic ? "Post Offer" : "Send Offer"} · fund {fmtGemas(entry)}
        </Button>
      )}
    </>
  );
}
