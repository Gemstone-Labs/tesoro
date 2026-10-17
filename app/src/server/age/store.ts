/** The 18+ confirmations: one per Account (authority), off chain. */
export interface AgeStore {
  /** When the Account confirmed (ISO time), or null when it has not. */
  get(authority: string): Promise<string | null>;
  /** Records the confirmation; the first time stays. */
  confirm(authority: string, at: string): Promise<void>;
}

/** In memory, for tests and local work. */
export class MemoryAgeStore implements AgeStore {
  readonly rows = new Map<string, string>();
  async get(authority: string) {
    return this.rows.get(authority) ?? null;
  }
  async confirm(authority: string, at: string) {
    if (!this.rows.has(authority)) this.rows.set(authority, at);
  }
}
