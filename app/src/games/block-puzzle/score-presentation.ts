/** Presentation receipts are additive: a later small move can arrive before an earlier clear. */
export function createScorePresentation(receive: (total: number, impact: number) => void) {
  let shown = 0;
  let generation = 0;
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const dispose = () => { generation++; pending.forEach(clearTimeout); pending.clear(); };
  const settle = (total: number) => { dispose(); shown = total; receive(shown, 0); };
  return {
    award(points: number, delay: number, impact: number) {
      const round = generation;
      const credit = () => { if (round === generation) { shown += points; receive(shown, impact); } };
      if (delay === 0) { credit(); return; }
      const timer = setTimeout(() => { pending.delete(timer); credit(); }, delay);
      pending.add(timer);
    },
    settle,
    reset: () => settle(0),
    dispose,
  };
}
