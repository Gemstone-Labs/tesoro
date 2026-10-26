/** tesoro_bridge `BridgeError::LegacyUnits`: a Position opened before units were normalised is never paid. */
const LEGACY_UNITS = 6044;

export const isLegacyUnits = (why: string | null): boolean => why !== null && (new RegExp(`"Custom":${LEGACY_UNITS}\\b`).test(why) || /LegacyUnits/.test(why));

/** Subjects the keeper has found impossible to ever send: skipped on every later pass, logged once. */
export class PermanentRefusals {
  private readonly subjects = new Set<string>();

  has(subject: string): boolean {
    return this.subjects.has(subject);
  }

  note(subject: string, reason: string, log: (msg: string) => void): void {
    if (this.subjects.has(subject)) return;
    this.subjects.add(subject);
    log(`SKIP for good: ${reason}; not retried`);
  }
}
