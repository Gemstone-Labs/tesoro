"use client";

import { useSyncExternalStore } from "react";
import { CheckIcon } from "./icons";
import "./toast.css";

interface ToastItem {
  id: number;
  text: string;
}

export const TOAST_MS = 4000;
const MAX_VISIBLE = 3;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: ToastItem[]) {
  items = next;
  listeners.forEach((l) => l());
}

export function dismissToast(id: number) {
  publish(items.filter((t) => t.id !== id));
}

/** Confirms a finished action ("Deposit 1 withdrawn."). Shows above the bottom nav for a few seconds. Errors and progress stay inline. */
export function toast(text: string) {
  const id = nextId++;
  publish([...items, { id, text }].slice(-MAX_VISIBLE));
  setTimeout(() => dismissToast(id), TOAST_MS);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Mounted once in the app shell. */
export function ToastHost() {
  const list = useSyncExternalStore(subscribe, () => items, () => items);
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {list.map((t) => (
        <button key={t.id} type="button" className="cut cut-card toast" onClick={() => dismissToast(t.id)}>
          <CheckIcon aria-hidden="true" />
          <span>{t.text}</span>
        </button>
      ))}
    </div>
  );
}
