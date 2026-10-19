/** Temporary: side-panel style takes the founder flips between in Practice. Delete with panels.css once one is picked. */
import { useSyncExternalStore } from "react";
export const PANEL_STYLES = ["a", "b", "c", "d", "e"] as const;
export type PanelStyle = (typeof PANEL_STYLES)[number];

export const PANEL_NAMES: Record<PanelStyle, string> = {
  a: "Brass and wood",
  b: "Field dossier",
  c: "Teletype",
  d: "Map-table glass",
  e: "Canvas and stitching",
};

export const PANEL_STORAGE_KEY = "vg-panels";

const isStyle = (v: string | null | undefined): v is PanelStyle => PANEL_STYLES.includes(v as PanelStyle);

/** `?panels=` wins, then what was remembered, then take A. */
export function parsePanelStyle(search: string, stored: string | null): PanelStyle {
  const q = new URLSearchParams(search).get("panels")?.toLowerCase();
  if (isStyle(q)) return q;
  const s = stored?.toLowerCase();
  return isStyle(s) ? s : "a";
}

const CHANGED = "vg-panels-change";

function read(): PanelStyle {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(PANEL_STORAGE_KEY);
  } catch {}
  return parsePanelStyle(window.location.search, stored);
}

function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  return () => window.removeEventListener(CHANGED, onChange);
}

/** The chosen take: take A on the server and in real Matches, the URL / remembered choice in the browser. */
export function usePanelStyle(switchable: boolean): [PanelStyle, (s: PanelStyle) => void] {
  const style = useSyncExternalStore(subscribe, (): PanelStyle => (switchable ? read() : "a"), (): PanelStyle => "a");
  const set = (s: PanelStyle) => {
    try {
      localStorage.setItem(PANEL_STORAGE_KEY, s);
    } catch {}
    // a ?panels in the URL would keep winning: drop it
    const url = new URL(window.location.href);
    if (url.searchParams.has("panels")) {
      url.searchParams.delete("panels");
      window.history.replaceState(null, "", url);
    }
    window.dispatchEvent(new Event(CHANGED));
  };
  return [style, set];
}
