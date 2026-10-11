const KEY = "tesoro.sfx";

type Store = Pick<Storage, "getItem" | "setItem">;

function browserStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

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
