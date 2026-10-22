"use client";

import { useEffect, useState } from "react";
import { AlertIcon, Button } from "@/components/ui";
import { useAuth } from "@/lib/auth/context";
import { notifyCall, notifyReady, type NotifyStatus } from "@/lib/chain/notify-client";
import { plainError } from "@/lib/errors";
import "./account.css";
import { BRAND } from "@/lib/brand";

export interface NotifySettingsViewProps {
  /** Null while it loads. */
  status: NotifyStatus | null;
  busy?: string | null;
  error?: string | null;
  /** The address being typed. */
  draft: string;
  onDraft: (v: string) => void;
  onSave: () => void;
  onToggle: (enabled: boolean) => void;
}

/** "Email me when my Match settles": the address, its verify state and the off switch. */
export function NotifySettingsView({ status, busy = null, error = null, draft, onDraft, onSave, onToggle }: NotifySettingsViewProps) {
  const changed = draft.trim() !== "" && draft.trim() !== (status?.email ?? "");
  return (
    <section className="stack ns" aria-label="Email notifications">
      <div className="field">
        <label className="label" htmlFor="ns-email">Email me when my Match settles</label>
        <span className="cut cut-chip ctl">
          <input
            id="ns-email"
            className="input"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={draft}
            onChange={(e) => onDraft(e.target.value)}
            disabled={status === null || busy !== null}
            aria-describedby="ns-hint"
          />
        </span>
        <small id="ns-hint" className="meta">
          {status === null
            ? error
              ? null
              : "Loading…"
            : status.email === null
              ? "Optional. We only use it to tell you how your Matches went. It is never public."
              : status.verified
                ? "Confirmed. You get an email when a Match you played settles."
                : "Check your inbox and tap the link to confirm. Until then we send nothing else."}
        </small>
      </div>
      {status?.email && status.verified && (
        <label className="ep-wallet">
          <input type="checkbox" checked={status.enabled} disabled={busy !== null} onChange={(e) => onToggle(e.target.checked)} />
          <span>
            <b>Send me emails</b>
            <small className="meta">Turn this off to stop all emails from {BRAND.name}.</small>
          </span>
        </label>
      )}
      {error && (
        <div className="status err" role="alert">
          <AlertIcon /> {error}
        </div>
      )}
      <Button size="sm" type="button" onClick={onSave} disabled={!changed || busy !== null}>
        {busy ?? (status?.email ? "Change email" : "Save email")}
      </Button>
    </section>
  );
}

/** The signed-in Player's settings, wired to /api/notify. */
export function NotifySettingsPanel() {
  const auth = useAuth();
  const [status, setStatus] = useState<NotifyStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const signer = auth.signer;

  useEffect(() => {
    let live = true;
    notifyReady()
      .then((r) => live && setReady(r))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!signer || !ready) return;
    let live = true;
    notifyCall("status", signer, auth.getAccessToken)
      .then((s) => {
        if (!live) return;
        setStatus(s);
        setDraft(s.email ?? "");
      })
      .catch((e) => live && setError(plainError(e)));
    return () => {
      live = false;
    };
  }, [signer, ready, auth.getAccessToken]);

  async function run(what: string, step: "set-email" | "set-enabled", body: { email?: string; enabled?: number }) {
    if (!signer) return;
    setError(null);
    setBusy(what);
    try {
      setStatus(await notifyCall(step, signer, auth.getAccessToken, body));
    } catch (e) {
      setError(plainError(e));
    } finally {
      setBusy(null);
    }
  }

  if (!signer || !ready) return null;
  return (
    <NotifySettingsView
      status={status}
      busy={busy}
      error={error}
      draft={draft}
      onDraft={setDraft}
      onSave={() => run("Sending the link", "set-email", { email: draft.trim() })}
      onToggle={(on) => run("Saving", "set-enabled", { enabled: on ? 1 : 0 })}
    />
  );
}
