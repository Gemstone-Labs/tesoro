"use client";

import { useId, useState, type ReactNode } from "react";
import { Info } from "lucide-react";
import "./tip.css";

type Align = "start" | "center" | "end";

/** An ⓘ that explains a figure: opens on hover or focus, and on tap (phones). */
export function InfoTip({ label, children, align = "center" }: { label: string; children: ReactNode; align?: Align }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className={`tip tip-${align}`} onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="tip-btn"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onBlur={() => setOpen(false)}
      >
        <Info size={15} aria-hidden="true" />
      </button>
      <span role="tooltip" id={id} className={`tip-bubble below${open ? " open" : ""}`}>
        {children}
      </span>
    </span>
  );
}

/** Explains a button on hover, also while it is disabled (the reason it can't be pressed). */
export function HoverHint({ hint, children, align = "start" }: { hint: ReactNode; children: ReactNode; align?: Align }) {
  const id = useId();
  if (!hint) return <>{children}</>;
  return (
    <span className={`tip tip-${align}`} aria-describedby={id}>
      {children}
      <span role="tooltip" id={id} className="tip-bubble above">
        {hint}
      </span>
    </span>
  );
}
