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
