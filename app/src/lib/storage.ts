export type Store = Pick<Storage, "getItem" | "setItem">;

/** The browser's localStorage, or null on the server or when access throws (blocked site data). */
export function browserStore(): Store | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
