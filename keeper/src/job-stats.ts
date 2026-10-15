/** What each keeper job last did, fed by `runJob` and read by the alerts. */
export interface JobStat {
  /** First time the job ran, or last time it succeeded. */
  okAt: number;
  failedInARow: number;
  lastError: string;
}

export class JobTracker {
  private jobs = new Map<string, JobStat>();

  ok(name: string, now = Date.now()) {
    this.jobs.set(name, { okAt: now, failedInARow: 0, lastError: "" });
  }

  fail(name: string, error: string, now = Date.now()) {
    const j = this.jobs.get(name) ?? { okAt: now, failedInARow: 0, lastError: "" };
    this.jobs.set(name, { okAt: j.okAt, failedInARow: j.failedInARow + 1, lastError: error });
  }

  /** A run that started but has not finished: the job exists (its clock starts) but has no outcome yet. */
  started(name: string, now = Date.now()) {
    if (!this.jobs.has(name)) this.jobs.set(name, { okAt: now, failedInARow: 0, lastError: "" });
  }

  entries(): [string, JobStat][] {
    return [...this.jobs];
  }
}

export const jobs = new JobTracker();
