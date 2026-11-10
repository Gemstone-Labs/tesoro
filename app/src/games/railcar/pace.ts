/**
 * When a Jumped Player's page may send a backup signal.
 *
 * The aboard Players' pages together send the car's ~5 signals a second. A page whose Player has Jumped is a backup for the
 * case that those pages close, so it stays silent while the Table's pace mark keeps moving (every signal that lands moves it)
 * and sends only after a clear gap. That keeps a car near 5 a second instead of up to 10 (ticket 25).
 */

/** The pace mark must have stood still this long, by the page's own reads, before a backup sends. */
export const BACKUP_QUIET_MS = 2_500;
/** Each seat waits this much longer than the one before (up to `STAGGER_SEATS`), so the backups don't all go together. */
const STAGGER_MS = 250;
const STAGGER_SEATS = 10;
/** A page whose last read of the Table is older than this cannot tell whether signals are landing. */
const STALE_READ_MS = 3_000;

export const backupDue = (o: { quietMs: number; tableSeat: number }): boolean => o.quietMs >= BACKUP_QUIET_MS + (o.tableSeat % STAGGER_SEATS) * STAGGER_MS;

/** Tracks the Table's pace mark across a page's reads. */
export class PaceWatch {
  private slot: bigint | null = null;
  private since = 0;
  private lastRead = 0;

  /** The page read the Table, whose pace mark was `paceSlot`, at `at` (ms). */
  read(paceSlot: bigint, at: number) {
    if (this.slot !== paceSlot) {
      this.slot = paceSlot;
      this.since = at;
    }
    this.lastRead = at;
  }

  reset() {
    this.slot = null;
    this.since = 0;
    this.lastRead = 0;
  }

  /** How long the mark has stood still across reads; 0 when the page has no recent read (it cannot tell). */
  quietMs(now: number): number {
    if (this.slot === null || now - this.lastRead > STALE_READ_MS) return 0;
    return now - this.since;
  }
}
