import { browserStore, type Store } from "@/lib/storage";

const KEY = "tesoro.sfx";

/** True when the Player turned game sound off. Sound is on until they do; storage that throws counts as on. */
export function readMuted(store: Store | null = browserStore()): boolean {
  try {
    return store?.getItem(KEY) === "off";
  } catch {
    return false;
  }
}

export function writeMuted(muted: boolean, store: Store | null = browserStore()): void {
  try {
    store?.setItem(KEY, muted ? "off" : "on");
  } catch {
    // storage blocked: the choice lasts until reload
  }
}
