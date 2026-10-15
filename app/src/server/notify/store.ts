/** The private email store: one record per Account (authority), off chain. */
export interface NotifyRecord {
  email: string;
  verified: boolean;
  enabled: boolean;
  /** UTC day (YYYY-MM-DD) `sentToday` counts. */
  sentDay: string | null;
  sentToday: number;
  /** Messages held for the daily digest. */
  digest: { subject: string; body: string }[];
}

export interface NotifyStore {
  get(authority: string): Promise<NotifyRecord | null>;
  /** Sets the address, unverified, with a fresh verify token (the old token stops working). */
  saveEmail(authority: string, email: string, token: string): Promise<void>;
  /** Marks the address behind `token` verified; null when the token is unknown or already used. */
  verify(token: string): Promise<string | null>;
  setEnabled(authority: string, enabled: boolean): Promise<void>;
  /** True the first time an event id is claimed, false after. */
  claimEvent(id: string, authority: string): Promise<boolean>;
  releaseEvent(id: string): Promise<void>;
  /** Counts one sent email on `day`, resetting the counter on a new day. */
  recordSent(authority: string, day: string): Promise<void>;
  addDigest(authority: string, day: string, message: { subject: string; body: string }): Promise<void>;
}

export const sentOn = (r: NotifyRecord | null, day: string) => (r && r.sentDay === day ? r.sentToday : 0);

/** In memory, for tests and local work. */
export class MemoryNotifyStore implements NotifyStore {
  readonly records = new Map<string, NotifyRecord & { token: string | null }>();
  readonly events = new Set<string>();

  async get(authority: string) {
    const r = this.records.get(authority);
    return r ? { email: r.email, verified: r.verified, enabled: r.enabled, sentDay: r.sentDay, sentToday: r.sentToday, digest: r.digest } : null;
  }
  async saveEmail(authority: string, email: string, token: string) {
    const prev = this.records.get(authority);
    this.records.set(authority, { sentDay: null, sentToday: 0, digest: [], enabled: true, ...prev, email, verified: false, token });
  }
  async verify(token: string) {
    for (const [authority, r] of this.records) {
      if (r.token === token) {
        r.verified = true;
        r.token = null;
        return authority;
      }
    }
    return null;
  }
  async setEnabled(authority: string, enabled: boolean) {
    const r = this.records.get(authority);
    if (r) r.enabled = enabled;
  }
  async claimEvent(id: string) {
    if (this.events.has(id)) return false;
    this.events.add(id);
    return true;
  }
  async releaseEvent(id: string) {
    this.events.delete(id);
  }
  async recordSent(authority: string, day: string) {
    const r = this.records.get(authority);
    if (!r) return;
    r.sentToday = r.sentDay === day ? r.sentToday + 1 : 1;
    r.sentDay = day;
  }
  async addDigest(authority: string, day: string, message: { subject: string; body: string }) {
    const r = this.records.get(authority);
    if (r) r.digest.push(message);
    void day;
  }
}
