"use client";

import Link from "next/link";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { LogOut, Maximize2, Minimize2, Volume2, VolumeX } from "lucide-react";
import { armSound, isMuted, setMuted, sfx, subscribeMuted } from "./sfx";
import { isFullScreen, setFullScreen, subscribeFullScreen } from "./full-screen";

export interface GameMenuItem {
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}

export interface GameActionsProps {
  items?: GameMenuItem[];
  leaveHref?: string;
}

/** Shared actions for the ⋯ menu and the Practice pause card. */
export function GameActions({ items = [], leaveHref, menu = false, onSelect }: GameActionsProps & { menu?: boolean; onSelect?: () => void }) {
  const muted = useSyncExternalStore(subscribeMuted, isMuted, () => false);
  const full = useSyncExternalStore(subscribeFullScreen, isFullScreen, () => false);
  useEffect(() => armSound(), []);
  const actions = [
    ...items,
    {
      label: muted ? "Sound off" : "Sound on",
      icon: muted ? <VolumeX aria-hidden="true" /> : <Volume2 aria-hidden="true" />,
      checked: !muted,
      keepOpen: true,
      onSelect: () => {
        setMuted(!muted);
        if (muted) queueMicrotask(() => sfx("tick"));
      },
    },
    {
      label: full ? "Exit full screen" : "Full screen",
      icon: full ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />,
      checked: full,
      onSelect: () => setFullScreen(!full),
    },
  ];
  return <>
    {actions.map((action) => {
      const checked = "checked" in action ? action.checked : undefined;
      return <button key={action.label} type="button" role={menu ? checked === undefined ? "menuitem" : "menuitemcheckbox" : undefined}
        aria-checked={menu ? checked : undefined} aria-pressed={menu ? undefined : checked}
        onClick={() => {
          if (!("keepOpen" in action && action.keepOpen)) onSelect?.();
          action.onSelect();
        }}>
        {action.icon} {action.label}
      </button>;
    })}
    {leaveHref && <Link href={leaveHref} role={menu ? "menuitem" : undefined} onClick={onSelect}><LogOut aria-hidden="true" /> Leave</Link>}
  </>;
}
