"use client";

import { useEffect, useRef } from "react";

const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";


function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT}"]`);
    const s = existing ?? Object.assign(document.createElement("script"), { src: SCRIPT, async: true });
    s.addEventListener("load", () => resolve());
    s.addEventListener("error", () => reject(new Error("turnstile script")));
    if (!existing) document.head.appendChild(s);
  });
}

/**
 * Cloudflare Turnstile in "interaction-only" mode: invisible unless Cloudflare wants a click. Renders
 * nothing and loads no script when NEXT_PUBLIC_TURNSTILE_SITE_KEY is unset. The widget writes its token
 * into a hidden `cf-turnstile-response` input inside the form. `resetKey` re-issues a token (they are single use).
 */
export function TurnstileField({ resetKey }: { resetKey: unknown }) {
  const box = useRef<HTMLDivElement>(null);
  const id = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!SITE_KEY || !box.current) return;
    const el = box.current;
    let gone = false;
    loadScript()
      .then(() => {
        if (gone || !window.turnstile) return;
        id.current = window.turnstile.render(el, { sitekey: SITE_KEY, appearance: "interaction-only", theme: "auto" });
      })
      .catch(() => {});
    return () => {
      gone = true;
      if (id.current) window.turnstile?.remove(id.current);
      id.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (id.current) window.turnstile?.reset(id.current);
  }, [resetKey]);

  if (!SITE_KEY) return null;
  return <div ref={box} className="wl-turnstile" />;
}
