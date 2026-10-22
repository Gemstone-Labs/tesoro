/** The deposit acknowledgments: one per Account (authority) and wording version, off chain. */
export interface DepositAckStore {
  /** When the Account acknowledged this version (ISO time), or null when it has not. */
  get(authority: string, version: string): Promise<string | null>;
  /** Records the acknowledgment; the first time stays. */
  confirm(authority: string, version: string, at: string): Promise<void>;
}

/** In memory, for tests and local work. Keys are `${authority}|${version}`. */
export class MemoryDepositAckStore implements DepositAckStore {
  readonly rows = new Map<string, string>();
  async get(authority: string, version: string) {
    return this.rows.get(`${authority}|${version}`) ?? null;
  }
  async confirm(authority: string, version: string, at: string) {
    const k = `${authority}|${version}`;
    if (!this.rows.has(k)) this.rows.set(k, at);
  }
}
