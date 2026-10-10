import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Chain } from "@/lib/mock/types";
import { ArrowIcon } from "./icons";

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");

/* ——— Card ——— */
export function Card({
  children,
  className,
  flush,
  large,
  as: Tag = "div",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  flush?: boolean;
  large?: boolean;
  as?: "div" | "section" | "article" | "li";
} & React.HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={cx("cut cut-card card", flush && "flush", large && "lg", className)} {...rest}>
      {children}
    </Tag>
  );
}

/* ——— Row ——— */
export function Thumb({ children, variant }: { children: ReactNode; variant?: "poker" }) {
  return <span className={cx("thumb", variant)} aria-hidden="true">{children}</span>;
}

interface RowProps {
  thumb?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  /** Trailing call to action text. `money` tone is emerald: only where Gemas move. */
  cta?: string;
  ctaTone?: "neutral" | "money";
  href?: string;
  onClick?: () => void;
  children?: ReactNode;
}

export function Row({ thumb, title, meta, cta, ctaTone = "neutral", href, onClick, children }: RowProps) {
  const inner = (
    <>
      {thumb}
      <span className="row-body">
        <span className="row-title">{title}</span>
        {meta && <span className="row-meta">{meta}</span>}
      </span>
      {children}
      {cta && (
        <span className={cx("row-cta", ctaTone === "money" && "money")}>
          {cta}
          <ArrowIcon width={12} height={12} />
        </span>
      )}
    </>
  );
  const cls = "cut cut-card row";
  if (href) return <Link href={href} className={cls}>{inner}</Link>;
  if (onClick) return <button type="button" className={cls} onClick={onClick}>{inner}</button>;
  return <div className={cls}>{inner}</div>;
}

/* ——— Chip / ChainChip ——— */
export function Chip({
  children,
  tone = "neutral",
  icon,
}: {
  children: ReactNode;
  tone?: "neutral" | "strong" | "money" | "warn" | "danger";
  icon?: ReactNode;
}) {
  return (
    <span className={cx("cut cut-chip chip", tone !== "neutral" && tone)}>
      {icon}
      {children}
    </span>
  );
}

export function ChainChip({ chain }: { chain: Chain }) {
  return <span className="cut cut-chip chip chain">{chain}</span>;
}

/* ——— Button ——— */
type ButtonProps = {
  variant?: "money" | "neutral";
  size?: "md" | "sm" | "lg";
  block?: boolean;
  href?: string;
  icon?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className">;

/** `money` (facet gradient) is for actions where Gemas move: Enter, Offer, Redeem, Advance. */
export function Button({ variant = "neutral", size = "md", block, href, icon, children, ...rest }: ButtonProps) {
  const cls = cx("cut cut-btn btn", variant, size !== "md" && size, block && "block");
  if (href && !rest.disabled) {
    return <Link href={href} className={cls} onClick={rest.onClick as React.MouseEventHandler<HTMLAnchorElement> | undefined}>{icon}{children}</Link>;
  }
  return (
    <button type="button" className={cls} {...rest}>
      {icon}
      {children}
    </button>
  );
}

/* ——— Meter ——— */
export function Meter({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="meter" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <span className="label">{children}</span>;
}

/* ——— Skeleton ——— */
/**
 * Loading placeholders shaped like the cards that are coming. `label` is announced to screen
 * readers in place of the visible shapes.
 */
export function SkeletonCards({ count = 3, label, className, avatar = true }: { count?: number; label: string; className?: string; avatar?: boolean }) {
  return (
    <>
      <span className="sr-only" role="status">
        {label}
      </span>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={cx("cut cut-card skel", className)} aria-hidden="true">
          {avatar && <span className="cut cut-btn skel-av" />}
          <span className="skel-lines">
            <span className="skel-line lg" style={{ width: "58%" }} />
            <span className="skel-line" style={{ width: "82%" }} />
            <span className="skel-line" style={{ width: "40%" }} />
          </span>
        </div>
      ))}
    </>
  );
}

/* ——— Busy: a spinner and one plain line for a step the Player waits through ——— */
export function Busy({ children }: { children: ReactNode }) {
  return (
    <p className="status busy" role="status">
      <span className="spinner" aria-hidden />
      {children}
    </p>
  );
}
