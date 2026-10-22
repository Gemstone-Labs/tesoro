"use client";

import { useMemo } from "react";
import { Check, Link2 } from "lucide-react";
import { PlayerAvatar, PlayerName, usePlayerLabel } from "@/components/account/Player";
import { Button, Sheet } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { accountHistory } from "@/lib/chain/history";
import { useFriends } from "@/lib/friends/FriendsProvider";
import { recordAgainst, recordText, sortFriends } from "@/lib/friends/record";
import "./friends.css";

/**
 * Who a new Challenge is for (founder pick C3, as a centred modal): one of your Friends, or anyone with
 * the link. Open Challenge here starts it, like the button on the page.
 */
export function FriendPicker({
  open,
  picked,
  onClose,
  onPick,
  onOpen,
}: {
  open: boolean;
  picked: string | null;
  onClose: () => void;
  onPick: (account: string | null) => void;
  onOpen: () => void;
}) {
  const friends = useFriends();
  const { snapshot } = useAccount();
  const pickedName = usePlayerLabel(picked);
  const view = friends.view;
  const myRows = useMemo(() => (snapshot ? accountHistory(snapshot.matches) : []), [snapshot]);
  const records = useMemo(() => new Map((view?.friends ?? []).map((f) => [f.account, recordAgainst(myRows, f.account)])), [view, myRows]);
  const list = useMemo(() => sortFriends(view?.friends ?? [], records), [view, records]);

  return (
    <Sheet open={open} onClose={onClose} title="Challenge a friend">
      <div className="stack-lg">
        {!view ? (
          friends.status === "error" ? (
            <div className="stack">
              <p className="status err">Your Friends couldn’t load. {friends.error}</p>
              <Button block onClick={() => void friends.unlock()}>Try again</Button>
            </div>
          ) : (
            <p className="meta" role="status">Loading your Friends…</p>
          )
        ) : (
          <fieldset className="fp-list">
            <legend className="sr-only">Who the Challenge is for</legend>
            {list.length === 0 && <p className="meta">No Friends yet. Add Players from their Account page or share your Friend link.</p>}
            {list.map((f) => (
              <label key={f.account} className={`cut cut-card fp-row${picked === f.account ? " on" : ""}`}>
                <input type="radio" name="fp-friend" checked={picked === f.account} onChange={() => onPick(f.account)} />
                <span className="cut fp-av">
                  <PlayerAvatar account={f.account} size={48} />
                </span>
                <span className="fp-text">
                  <PlayerName account={f.account} className="fp-name" />
                  <small>{recordText(records.get(f.account)!)}</small>
                </span>
                <span className="fp-check" aria-hidden="true">
                  {picked === f.account && <Check />}
                </span>
              </label>
            ))}
            <label className={`cut cut-card fp-row${picked === null ? " on" : ""}`}>
              <input type="radio" name="fp-friend" checked={picked === null} onChange={() => onPick(null)} />
              <span className="cut fp-av fp-link">
                <Link2 aria-hidden="true" />
              </span>
              <span className="fp-text">
                <b className="fp-name">Anyone with the link</b>
                <small>Whoever opens your link first joins</small>
              </span>
              <span className="fp-check" aria-hidden="true">
                {picked === null && <Check />}
              </span>
            </label>
          </fieldset>
        )}
        <Button variant="money" block onClick={onOpen}>
          {picked ? `Open Challenge for ${pickedName}` : "Open Challenge"}
        </Button>
      </div>
    </Sheet>
  );
}
