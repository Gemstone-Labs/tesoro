"use client";

import { useEffect } from "react";
import { resolveTheme } from "./theme";

/** Keeps the landing theme while mounted (also across a remount) and drops it on the way out: the app is always dark. */
export function ThemeCleanup() {
  useEffect(() => {
    const html = document.documentElement;
    if (!html.dataset.theme) html.dataset.theme = resolveTheme();
    return () => void delete html.dataset.theme;
  }, []);
  return null;
}
