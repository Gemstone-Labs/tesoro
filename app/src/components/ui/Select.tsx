"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

export type SelectOption<T> = { value: T; label: string };

/**
 * Where a key moves the highlight in a list of `n` options, or null when the key does not move it.
 * Letters jump to the next option whose label starts with them, wrapping round.
 */
export function selectKeyTarget(key: string, at: number, labels: readonly string[]): number | null {
  const n = labels.length;
  if (!n) return null;
  if (key === "ArrowDown") return Math.min(at + 1, n - 1);
  if (key === "ArrowUp") return Math.max(at - 1, 0);
  if (key === "Home" || key === "PageUp") return 0;
  if (key === "End" || key === "PageDown") return n - 1;
  if (key.length === 1 && key.trim()) {
    const k = key.toLowerCase();
    for (let i = 1; i <= n; i++) {
      const j = (at + i) % n;
      if (labels[j].toLowerCase().startsWith(k)) return j;
    }
  }
  return null;
}

/** Room the list keeps from the window edge, and its gap from the button. */
const EDGE = 8;
const GAP = 6;

/**
 * A dropdown in the Cut style, in place of the browser's own option list (which ignores our surfaces
 * and fonts). The list opens in the top layer, so a sheet's scroll box or a cut's clip never hides it.
 * `framed` wraps the button in a control frame (`.cut.cut-chip.ctl`); unframed sits bare in a frame of
 * its own, like the Backing sort.
 */
export function Select<T extends string | number>({
  id,
  value,
  options,
  onChange,
  framed = true,
  disabled,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: {
  id?: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (v: T) => void;
  framed?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  const auto = useId();
  const buttonId = id ?? `${auto}-btn`;
  const listId = `${auto}-list`;
  const [opened, setOpen] = useState(false);
  const open = opened && !disabled;
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const chosen = options.findIndex((o) => o.value === value);
  const current = options[chosen] ?? options[0];

  const optionEls = () => [...(list.current?.querySelectorAll<HTMLElement>("[role=option]") ?? [])];
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const pick = (i: number) => {
    const o = options[i];
    if (o && o.value !== value) onChange(o.value);
    close(true);
  };

  // place the list under the button (above it when there is more room there), then focus the chosen option
  useLayoutEffect(() => {
    const el = pop.current;
    const box = list.current;
    const btn = button.current;
    if (!open || !el || !box || !btn) return;
    const place = () => {
      const r = (btn.closest(".ctl, .sel-host") ?? btn).getBoundingClientRect();
      const below = innerHeight - r.bottom - GAP - EDGE;
      const above = r.top - GAP - EDGE;
      box.style.maxHeight = "";
      const up = el.offsetHeight > below && above > below;
      el.style.minWidth = `${r.width}px`;
      box.style.maxHeight = `${Math.max(120, up ? above : below)}px`;
      el.style.left = `${Math.max(EDGE, Math.min(r.left, innerWidth - EDGE - el.offsetWidth))}px`;
      el.style.top = up ? "" : `${r.bottom + GAP}px`;
      el.style.bottom = up ? `${innerHeight - r.top + GAP}px` : "";
    };
    el.showPopover?.();
    place();
    const opts = optionEls();
    const start = opts[Math.max(chosen, 0)];
    start?.focus({ preventScroll: true });
    start?.scrollIntoView({ block: "nearest" });
    // the button moves with the page under it: follow it, and close if it scrolls out of view
    const follow = (e: Event) => {
      if (e.target instanceof Node && el.contains(e.target)) return;
      const r = btn.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) setOpen(false);
      else place();
    };
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!el.contains(t) && !btn.contains(t)) setOpen(false);
    };
    addEventListener("scroll", follow, true);
    addEventListener("resize", follow);
    document.addEventListener("pointerdown", away);
    return () => {
      removeEventListener("scroll", follow, true);
      removeEventListener("resize", follow);
      document.removeEventListener("pointerdown", away);
      if (el.matches(":popover-open")) el.hidePopover?.();
    };
    // chosen is read once, when the list opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onListKey = (e: React.KeyboardEvent) => {
    const opts = optionEls();
    const at = opts.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // the sheet under the list stays open
      close(true);
    } else if (e.key === "Tab") {
      setOpen(false);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(at);
    } else {
      const to = selectKeyTarget(e.key, at, options.map((o) => o.label));
      if (to === null) return;
      e.preventDefault();
      opts[to]?.focus();
    }
  };

  const trigger = (
    <button
      ref={button}
      id={buttonId}
      type="button"
      role="combobox"
      className={framed ? "select" : "sel-bare"}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listId}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => {
        if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
          e.preventDefault();
          setOpen(true);
        }
      }}
    >
      {current?.label}
    </button>
  );

  return (
    <>
      {framed ? <span className="cut cut-chip ctl">{trigger}</span> : trigger}
      <div ref={pop} popover="manual" className="cut cut-card sel-pop">
        <div
          ref={list}
          id={listId}
          role="listbox"
          className="sel-list"
          aria-labelledby={ariaLabelledBy ?? (ariaLabel ? undefined : buttonId)}
          aria-label={ariaLabelledBy ? undefined : ariaLabel}
          onKeyDown={onListKey}
        >
        {open &&
          options.map((o, i) => (
            <div
              key={String(o.value)}
              role="option"
              tabIndex={-1}
              aria-selected={i === chosen}
              className="sel-opt"
              onClick={() => pick(i)}
              onPointerMove={(e) => e.currentTarget.focus({ preventScroll: true })}
            >
              <span>{o.label}</span>
              <Check size={15} aria-hidden="true" />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
