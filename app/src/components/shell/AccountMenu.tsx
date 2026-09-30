"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, LogOut, User, Wallet } from "lucide-react";
import { useAuth } from "@/lib/auth/context";
import { avatarFor } from "@/lib/art";

/** The Account avatar with its menu: Account details, Wallet, Sign out. */
export function AccountMenu() {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const seed = auth.addresses.solana ?? auth.email ?? "guest";

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="acct" ref={root}>
      <button
        type="button"
        className="acct-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label="Account menu"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cut cut-btn avatar">
          <Image src={avatarFor(seed)} alt="" width={48} height={48} />
        </span>
        <ChevronDown aria-hidden="true" className="acct-chev" />
      </button>
      {open && (
        <div id={menuId} role="menu" className="cut cut-card acct-menu">
          {auth.email && <span className="acct-mail">{auth.email}</span>}
          <button type="button" role="menuitem" onClick={() => { setOpen(false); auth.openAccount(); }}>
            <User aria-hidden="true" /> Account
          </button>
          <Link href="/wallet" role="menuitem" onClick={() => setOpen(false)}>
            <Wallet aria-hidden="true" /> Wallet
          </Link>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); void auth.signOut(); }}>
            <LogOut aria-hidden="true" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}
