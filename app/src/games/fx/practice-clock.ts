/** A local game's time excludes pauses; real Matches always use their authoritative clock. */
export function createPracticeClock(source: () => number = Date.now) {
  let stoppedAt: number | null = null;
  let skipped = 0;
  return {
    now: () => (stoppedAt ?? source()) - skipped,
    pause() { stoppedAt ??= source(); },
    resume() {
      if (stoppedAt === null) return;
      skipped += source() - stoppedAt;
      stoppedAt = null;
    },
  };
}
