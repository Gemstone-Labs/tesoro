"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, Copy, Share2 } from "lucide-react";
import { Button } from "@/components/ui";
import { copyFriendLink, friendShareData, shareFriendLink, type FriendShareBrowser, type FriendShareResult } from "@/lib/friend-share";

/** Share and Copy always use the same add-me link displayed on Friends. */
export function FriendLinkShare({ code, disabled = false }: { code: string | null; disabled?: boolean }) {
  const [feedback, setFeedback] = useState<FriendShareResult | "idle">("idle");
  const [manualUrl, setManualUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  const url = code ? `${typeof window === "undefined" ? "" : window.location.host}/friend/${code}` : "";

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const act = async (action: "share" | "copy") => {
    if (!code || disabled || active.current) return;
    active.current = true;
    setBusy(true);
    if (timer.current) clearTimeout(timer.current);
    const data = friendShareData(code, window.location.origin);
    const browser: FriendShareBrowser = {
      share: typeof navigator.share === "function" ? (payload) => navigator.share(payload) : undefined,
      canShare: typeof navigator.canShare === "function" ? (payload) => navigator.canShare(payload) : undefined,
      copy: navigator.clipboard?.writeText ? (text) => navigator.clipboard.writeText(text) : undefined,
    };
    try {
      const result = await (action === "share" ? shareFriendLink(data, browser) : copyFriendLink(data.url, browser));
      setManualUrl(data.url);
      setFeedback(result);
      if (result === "copied" || result === "shared") timer.current = setTimeout(() => setFeedback("idle"), 2500);
    } finally {
      active.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <div className="fr-link-row">
        {url ? <span className="cut cut-chip fr-link-url mono" title={url}>{url}</span> : <span className="cut cut-chip fr-link-url skel-url" aria-label="Loading your link" />}
        <div className="fr-link-actions" role="group" aria-label="Add-me link actions">
          <Button size="sm" disabled={!code || disabled || busy} onClick={() => void act("copy")} icon={feedback === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}>
            {feedback === "copied" ? "Copied" : "Copy"}
          </Button>
          <Button size="sm" disabled={!code || disabled || busy} onClick={() => void act("share")} icon={<Share2 aria-hidden="true" />}>
            Share
          </Button>
        </div>
      </div>
      <span className="sr-only" role="status">
        {feedback === "copied" ? "Add-me link copied" : feedback === "shared" ? "Share menu opened" : ""}
      </span>
      {feedback === "manual" && (
        <div className="fr-link-manual">
          <label className="label" htmlFor={id}>Add-me link</label>
          <input id={id} className="input" type="url" readOnly value={manualUrl} onFocus={(event) => event.currentTarget.select()} />
          <p className="meta" role="status">Copy this link to share it.</p>
        </div>
      )}
    </>
  );
}
