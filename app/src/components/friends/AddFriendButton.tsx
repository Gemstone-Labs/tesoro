"use client";

import { useState } from "react";
import { Check, UserPlus } from "lucide-react";
import { Button } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { useFriends } from "@/lib/friends/FriendsProvider";
import { friendStatusText } from "@/lib/friends/words";
import "./friends.css";

/**
 * Add friend for one other Account: Add friend, then Request sent; Accept when they asked first;
 * Friends once you are. Signed out, it signs in first.
 */
export function AddFriendButton({ account, size, className }: { account: string; size?: "sm" | "lg"; className?: string }) {
  const { auth } = useAccount();
  const friends = useFriends();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const relation = friends.relation(account);
  if (relation === "self") return null;

  const run = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = relation === "incoming" ? await friends.act("accept", { from: account }) : await friends.act("request", { to: account });
      setNote(friendStatusText(r.status ?? ""));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Signed in but the list not read yet: the button waits rather than offering Add friend and then changing.
  const waiting = auth.status === "signed-in" && friends.status === "loading";
  const label = relation === "friend" ? "Friends" : relation === "sent" ? "Request sent" : relation === "incoming" ? "Accept" : "Add friend";
  const done = relation === "friend" || relation === "sent";
  return (
    <span className={`af${className ? ` ${className}` : ""}`}>
      <Button
        size={size}
        disabled={done || busy || waiting}
        aria-busy={waiting || undefined}
        icon={relation === "friend" ? <Check aria-hidden="true" /> : <UserPlus aria-hidden="true" />}
        onClick={() => auth.gate("add a friend", () => void run())}
      >
        {busy ? "Sending…" : label}
      </Button>
      {note && (
        <small className="af-note" role="status">
          {note}
        </small>
      )}
    </span>
  );
}
