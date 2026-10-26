"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Link2 } from "lucide-react";
import { Button } from "@/components/ui";
import { useAccount } from "@/lib/account";
import { copyFriendLink, friendShareData } from "@/lib/friend-share";
import { useFriends } from "@/lib/friends/FriendsProvider";

/** Copies your Friend link. Signed out, it signs in first; when the browser won't copy, it opens the Friends tab where the link shows. */
export function FriendLinkButton() {
  const { auth } = useAccount();
  const friends = useFriends();
  const [state, setState] = useState<"idle" | "busy" | "copied" | "error">("idle");
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = async () => {
    setState("busy");
    try {
      const { code } = await friends.act("link");
      if (!code) throw new Error("no link");
      const url = friendShareData(code, window.location.origin).url;
      const done = await copyFriendLink(url, { copy: navigator.clipboard?.writeText ? (t) => navigator.clipboard.writeText(t) : undefined });
      if (done === "manual") {
        router.push("/friends");
        return;
      }
      setState("copied");
    } catch {
      setState("error");
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2500);
  };

  return (
    <>
      <Button
        disabled={state === "busy"}
        icon={state === "copied" ? <Check aria-hidden="true" /> : <Link2 aria-hidden="true" />}
        onClick={() => auth.gate("share your Friend link", () => void run())}
      >
        {state === "copied" ? "Copied" : state === "error" ? "Try again" : "Friend link"}
      </Button>
      <span className="sr-only" role="status">
        {state === "copied" ? "Friend link copied" : ""}
      </span>
    </>
  );
}
