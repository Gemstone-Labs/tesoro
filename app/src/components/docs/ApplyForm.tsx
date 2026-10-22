"use client";

import { useState } from "react";
import { Button } from "@/components/ui";
import { checkApplication } from "@/lib/listing/apply";

const FIELDS = [
  { key: "studio", label: "Studio name", type: "text", autoComplete: "organization" },
  { key: "gameName", label: "Game name", type: "text" },
  { key: "programId", label: "Program address", type: "text" },
  { key: "contactEmail", label: "Contact email", type: "email", autoComplete: "email" },
  { key: "site", label: "Website (optional)", type: "url" },
] as const;

/** The free listing application. The server checks it again. */
export function ApplyForm() {
  const [v, setV] = useState<Record<string, string>>({});
  const [state, setState] = useState<{ kind: "idle" | "sending" | "done" | "error"; text?: string }>({ kind: "idle" });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const checked = checkApplication(v);
    if (!checked.ok) return setState({ kind: "error", text: checked.error });
    setState({ kind: "sending" });
    try {
      const res = await fetch("/api/listing/apply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(checked.value) });
      const json = await res.json().catch(() => ({}));
      setState(res.ok ? { kind: "done", text: json.message } : { kind: "error", text: json.error ?? "That didn’t go through. Try again in a moment." });
    } catch {
      setState({ kind: "error", text: "That didn’t go through. Try again in a moment." });
    }
  };

  if (state.kind === "done") return <p role="status">{state.text}</p>;
  return (
    <form className="stack" onSubmit={submit} noValidate>
      {FIELDS.map((f) => (
        <label key={f.key} className="stack">
          <span>{f.label}</span>
          <input type={f.type} autoComplete={"autoComplete" in f ? f.autoComplete : "off"} value={v[f.key] ?? ""} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
        </label>
      ))}
      <label className="stack">
        <span>What is your Game? (optional)</span>
        <textarea rows={4} maxLength={600} value={v.blurb ?? ""} onChange={(e) => setV({ ...v, blurb: e.target.value })} />
      </label>
      {state.kind === "error" && <p role="alert">{state.text}</p>}
      <Button variant="money" type="submit" disabled={state.kind === "sending"}>
        {state.kind === "sending" ? "Sending…" : "Apply for free"}
      </Button>
    </form>
  );
}
