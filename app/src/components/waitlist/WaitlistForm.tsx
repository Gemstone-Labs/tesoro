"use client";

import { useActionState, useEffect, useRef } from "react";
import { joinWaitlist, type WaitlistState } from "@/app/(marketing)/waitlist-action";
import { appHref } from "@/lib/landing/config";

const IDLE: WaitlistState = { status: "idle" };
const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://tesoro-fawn.vercel.app";
const SHARE_TEXT = "I just joined the Tesoro waitlist: play casual games with yield you haven't earned yet.";

export function WaitlistForm() {
  const [state, action, pending] = useActionState(joinWaitlist, IDLE);
  const source = useRef<HTMLInputElement>(null);
  const referrer = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const utm = new URLSearchParams(location.search).get("utm_source");
    if (utm && source.current) source.current.value = utm.slice(0, 80);
    if (document.referrer && referrer.current) referrer.current.value = document.referrer;
  }, []);

  if (state.status === "ok") {
    const share = `https://x.com/intent/post?text=${encodeURIComponent(SHARE_TEXT)}&url=${encodeURIComponent(SITE)}`;
    return (
      <div className="wl-done" role="status">
        <p className="wl-done-title">You&apos;re on the list.</p>
        <p className="wl-done-note">We&apos;ll email you when your spot opens.</p>
        <div className="wl-done-links">
          <a className="btn money cut cut-btn" href={appHref()}>
            Try it now
          </a>
          <a className="btn neutral cut cut-btn" href={share} target="_blank" rel="noopener noreferrer">
            Share on X
          </a>
        </div>
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
        <input
          id="wl-email"
          name="email"
          className="cut input"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          required
          maxLength={254}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "wl-error" : undefined}
        />
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
      <input type="hidden" name="utm_source" ref={source} />
      <input type="hidden" name="referrer" ref={referrer} />
      <p id="wl-error" className="wl-error" role="alert">
        {error}
      </p>
    </form>
  );
}
