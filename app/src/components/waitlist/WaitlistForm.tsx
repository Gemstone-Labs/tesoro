"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { joinWaitlist, type WaitlistState } from "@/app/(marketing)/waitlist-action";
import { art } from "@/lib/art";
import { appHref } from "@/lib/landing/config";
import { SITE_URL } from "@/lib/site";
import { gemFor, shareText, spotPath } from "@/lib/waitlist-spot";
import { PackReveal } from "./PackReveal";
import { TurnstileField } from "./TurnstileField";

const IDLE: WaitlistState = { status: "idle" };
const SITE = SITE_URL;
const SHARE_TEXT = "I just joined the Tesoro waitlist: play casual games with yield you haven't earned yet.";

const postUrl = (text: string, url: string) =>
  `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;

/** `source` credits a shared spot link when the visitor arrived without a utm_source. */
export function WaitlistForm({ source: invitedBy }: { source?: string }) {
  const [state, action, pending] = useActionState(joinWaitlist, IDLE);
  const source = useRef<HTMLInputElement>(null);
  const referrer = useRef<HTMLInputElement>(null);
  const [pack, setPack] = useState<"sealed" | "open" | "closed">("sealed");
  // The gem stays out of the page until the pack has been opened: it would show through the pack.
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    const utm = new URLSearchParams(location.search).get("utm_source");
    if (source.current) source.current.value = utm?.slice(0, 80) ?? invitedBy ?? "";
    if (document.referrer && referrer.current) referrer.current.value = document.referrer;
  }, [invitedBy]);

  if (state.status === "ok") {
    const gem = state.spot ? gemFor(state.spot) : null;
    const share = gem ? postUrl(shareText(gem), SITE + spotPath(gem.spot)) : postUrl(SHARE_TEXT, SITE);
    return (
      <div className="wl-done" role="status">
        <p className="wl-done-title">You&apos;re on the list.</p>
        {gem && opened ? (
          <div className="wl-gem" style={{ "--gem": gem.hex } as React.CSSProperties}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="wl-gem-art" src={art.avatars[gem.avatar - 1]} alt="" width={72} height={72} />
            <div>
              <p className="wl-gem-spot mono">Spot #{gem.spot}</p>
              <p className="wl-gem-name">You pulled the {gem.name}.</p>
            </div>
          </div>
        ) : null}
        <p className="wl-done-note">We&apos;ll email you when your spot opens.</p>
        <div className="wl-done-links">
          <a className="btn money cut cut-btn" href={appHref()}>
            Try it now
          </a>
          {gem ? (
            <button type="button" className="btn neutral cut cut-btn" onClick={() => setPack(opened ? "open" : "sealed")}>
              {opened ? "See your card" : "Open your pack"}
            </button>
          ) : (
            <a className="btn neutral cut cut-btn" href={share} target="_blank" rel="noopener noreferrer">
              Share on X
            </a>
          )}
        </div>
        {gem && pack !== "closed" ? (
          <PackReveal
            gem={gem}
            shareHref={share}
            tryHref={appHref()}
            sealed={pack === "sealed"}
            onOpen={() => setOpened(true)}
            onClose={() => setPack("closed")}
          />
        ) : null}
      </div>
    );
  }

  const error = state.status === "error" ? state.message : undefined;
  return (
    <form className="wl-form" action={action} noValidate={false}>
      <label className="label" htmlFor="wl-email">
        Email
      </label>
      <div className="wl-row">
        <span className="cut cut-chip ctl">
          <input
            id="wl-email"
            name="email"
            className="input"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            required
            maxLength={254}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "wl-error" : undefined}
          />
        </span>
        <button type="submit" className="btn money cut cut-btn wl-join" disabled={pending}>
          {pending ? "Joining…" : "Join the waitlist"}
        </button>
      </div>
      <div className="wl-hp" aria-hidden>
        <label>
          Company
          <input name="company" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <TurnstileField resetKey={state} />
      <input type="hidden" name="utm_source" ref={source} />
      <input type="hidden" name="referrer" ref={referrer} />
      <p id="wl-error" className="wl-error" role="alert">
        {error}
      </p>
    </form>
  );
}
