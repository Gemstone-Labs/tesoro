/**
 * The public Tells of a ride (the Table's `screws` count and `tell` flags). A ride always shows the screws; the panel and
 * the sparks each show on some rides only (decisions Q39), and nothing says one will not come. Every screw counts alike:
 * the false ones and the real ones are one number, so nothing here says which screw was real.
 */
export interface Tells {
  /** Screws heard so far, false and real together. */
  screws: number;
  /** The bolt and rattling panel have shown. */
  panel: boolean;
  /** The sparks and creak have shown. */
  sparks: boolean;
}

export const NO_TELLS: Tells = { screws: 0, panel: false, sparks: false };

/** The Table's `tell` byte: the later Tells shown so far. */
export const TELL_PANEL = 1;
export const TELL_SPARKS = 2;

export const tellsOf = (screws: number, flags: number): Tells => ({ screws, panel: (flags & TELL_PANEL) !== 0, sparks: (flags & TELL_SPARKS) !== 0 });

/** A ride that shows every Tell, `stage` Tells in: 1 the screws, 2 the panel too, 3 the sparks too (fixtures and stories). */
export const tellsUpTo = (stage: number): Tells => ({ screws: stage >= 1 ? 1 : 0, panel: stage >= 2, sparks: stage >= 3 });
