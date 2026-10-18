"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { joinWaitlist, type WaitlistState } from "@/app/(marketing)/waitlist-action";
import { art } from "@/lib/art";
import { appHref } from "@/lib/landing/config";
import { roleTags, type Role } from "@/lib/waitlist-role";
import { gemFor, shareText, spotPath } from "@/lib/waitlist-spot";
import { PackReveal } from "./PackReveal";
import { RolePicker } from "./RolePicker";
import { HEADLINES, headlineStore, useHeadline } from "./WaitlistHeadline";
import { TurnstileField } from "./TurnstileField";

const IDLE: WaitlistState = { status: "idle" };
const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.playtesoro.com";
const SHARE_TEXT = "I just joined the Tesoro waitlist: play casual games with yield you haven't earned yet.";

const postUrl = (text: string, url: string) =>
  `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;

/** Where the optional role question sits (prototype): A above the email, B under the button, C on the sealed pack. Founder picked A. */
type Take = "a" | "b" | "c";

/** Prototype wrapper: headline switcher, and Reset to run the signup again. */
export function WaitlistForm({ source }: { source?: string }) {
  const [run, setRun] = useState(0);
  const headline = useHeadline();
  return (
    <>
      <Form key={run} source={source} take="a" />
      <div className="wl-proto" role="group" aria-label="Prototype headline">
        <span>Headline</span>
        {HEADLINES.map((_, i) => (
          <button key={i} type="button" aria-pressed={headline === i} onClick={() => headlineStore.set(i)}>
            {i + 1}
          </button>
        ))}
        <button type="button" onClick={() => setRun((n) => n + 1)}>
          Reset
        </button>
      </div>
    </>
  );
}

/** `source` credits a shared spot link when the visitor arrived without a utm_source. */
function Form({ source: invitedBy, take }: { source?: string; take: Take }) {
  const [state, action, pending] = useActionState(joinWaitlist, IDLE);
  const [roles, setRoles] = useState<Role[]>([]);
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
              <p className="wl-gem-spot mono">
                Spot #{gem.spot}
                {roles.length ? ` · ${roleTags(roles).join(" · ")}` : ""}
              </p>
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
            roles={roles}
            onRoles={take === "c" ? setRoles : undefined}
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
      {take === "a" ? (
        <div className="wl-role-above">
          <RolePicker value={roles} onChange={setRoles} label="I'm here because…" hint="Optional. It goes on your card." />
        </div>
      ) : null}
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
      {take === "b" ? (
        <div className="wl-role-under">
          <RolePicker value={roles} onChange={setRoles} label="Optional: tap what fits, it goes on your card." size="sm" />
        </div>
      ) : null}
      {take !== "c" && roles.includes("studio") ? (
        <div className="wl-studio">
          <label className="label" htmlFor="wl-studio">
            Studio or game <span className="wl-role-hint">(optional)</span>
          </label>
          <span className="cut cut-chip ctl">
            <input id="wl-studio" name="studio" className="input" maxLength={120} placeholder="Studio name or a link" autoComplete="organization" />
          </span>
        </div>
      ) : null}
      <input type="hidden" name="role" value={roles.join(",")} />
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
