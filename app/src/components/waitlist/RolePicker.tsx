"use client";

import { ROLES, type Role } from "@/lib/waitlist-role";

/** Toggle chips for the optional "who are you" question. Several can be on; tap again to drop one. */
export function RolePicker({
  value,
  onChange,
  label,
  hint,
  size = "md",
}: {
  value: Role[];
  onChange: (next: Role[]) => void;
  label: string;
  hint?: string;
  size?: "sm" | "md";
}) {
  const toggle = (k: Role) => onChange(value.includes(k) ? value.filter((v) => v !== k) : ROLES.map((r) => r.key).filter((r) => r === k || value.includes(r)));
  return (
    <div className={`wl-role wl-role-${size}`} role="group" aria-label={label}>
      <p className="wl-role-label">
        {label}
        {hint ? <span className="wl-role-hint"> {hint}</span> : null}
      </p>
      <div className="wl-role-chips">
        {ROLES.map((r) => (
          <button
            key={r.key}
            type="button"
            className="wl-role-chip cut cut-chip"
            aria-pressed={value.includes(r.key)}
            onClick={() => toggle(r.key)}
          >
            {r.chip}
          </button>
        ))}
      </div>
    </div>
  );
}
