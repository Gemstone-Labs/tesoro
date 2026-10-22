"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import "./tip.css";

type Align = "start" | "center" | "end";

/**
 * An ⓘ that explains a figure: shows above the icon on hover or focus, and stays open on tap (phones). The
 * bubble is drawn at the page level so the card's cut corners can't clip it; inside a modal it is drawn in the modal,
 * which sits above the page.
 */
export function InfoTip({ label, children, align = "center" }: { label: string; children: ReactNode; align?: Align }) {
  const id = useId();
  const ref = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ top: number; x: number } | null>(null);
  const [host, setHost] = useState<Element | null>(null);
  const [pinned, setPinned] = useState(false);
  const show = () => {
    const btn = ref.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setHost(btn.closest("dialog"));
    setAt({ top: r.top - 8, x: align === "start" ? r.left : align === "end" ? r.right : r.left + r.width / 2 });
  };
  const hide = () => {
    setAt(null);
    setPinned(false);
  };
  useEffect(() => {
    if (!at) return;
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [at]);
  const shift = align === "start" ? "0" : align === "end" ? "-100%" : "-50%";
  return (
    <span className="tip">
      <button
        ref={ref}
        type="button"
        className="tip-btn"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={!!at}
        onMouseEnter={show}
        onMouseLeave={() => !pinned && setAt(null)}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => {
          e.stopPropagation();
          if (pinned) hide();
          else {
            show();
            setPinned(true);
          }
        }}
      >
        <Info size={15} aria-hidden="true" />
      </button>
      {typeof document !== "undefined" &&
        createPortal(
          <span role="tooltip" id={id} className={`tip-bubble fixed${at ? " open" : ""}`} style={at ? { top: at.top, left: at.x, transform: `translate(${shift}, -100%)` } : undefined}>
            {children}
          </span>,
          host ?? document.body,
        )}
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
