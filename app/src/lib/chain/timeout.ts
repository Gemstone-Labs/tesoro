/** Rejects with a plain "took too long" error if `p` has not settled within `ms`; `p` itself keeps running. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("This is taking too long. Try again in a moment.")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** `p`'s value, or `fallback` when it fails or is still running after `ms`: for a section the page can do without. */
export function orFallback<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return withTimeout(p, ms).catch(() => fallback);
}
