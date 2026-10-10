import Link from "next/link";
import type { ReactNode } from "react";
import { PlayerName } from "./Player";
import "./account.css";

/**
 * A Player wherever one is shown, linking to their Account. `account` is the Account key; the
 * default content is the Player's name (Profile, .sol, .eth or the short key). `newTab` keeps the page underneath (an open drawer, a tab) as it is.
 */
export function AccountLink({
  account,
  className,
  newTab,
  decorative,
  children,
}: {
  account: string;
  className?: string;
  newTab?: boolean;
  /** An avatar next to a link that already names the Player: clickable, but skipped by the keyboard and screen readers. */
  decorative?: boolean;
  children?: ReactNode;
}) {
  return (
    <Link
      href={`/account/${account}`}
      className={`acc-link${className ? ` ${className}` : ""}`}
      {...(newTab ? { target: "_blank", rel: "noopener" } : {})}
      {...(decorative ? { tabIndex: -1, "aria-hidden": true } : {})}
    >
      {children ?? <PlayerName account={account} />}
    </Link>
  );
}
