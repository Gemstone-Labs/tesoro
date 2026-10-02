"use client";

import { useSyncExternalStore } from "react";
import type { Theme } from "./theme";

const readTheme = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");
const subscribeTheme = (onChange: () => void) => {
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
};

/** The landing theme on `<html data-theme>`, live: the 3D scenes and the nav toggle follow it. */
export const useTheme = (): Theme => useSyncExternalStore(subscribeTheme, readTheme, () => "dark" as Theme);
