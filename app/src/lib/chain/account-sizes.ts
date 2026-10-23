/**
 * Byte length of the current layout of the accounts devnet still holds in older layouts after the economy upgrade
 * (tesoro_core `MatchState::SPACE`, `SourceState::SPACE`, `OfferState::SPACE`). Matches and Sources written by the earlier
 * programs have other lengths and cannot be decoded; a list of "every MatchState" would throw on the first one. Every
 * `core.account.<type>.all()` is therefore filtered to the current length (`onlyCurrentLayouts`), as Positions are
 * (`position-size.ts`).
 */
export const CURRENT_SIZE = { matchState: 776, sourceState: 170, offerState: 174 } as const;

type AccountClient = { all: (filters?: unknown[]) => Promise<unknown[]> };

/** Makes `program.account.<type>.all()` skip accounts of an older layout. */
export function onlyCurrentLayouts(program: { account: Record<string, unknown> }): void {
  for (const [name, size] of Object.entries(CURRENT_SIZE)) {
    const client = program.account[name] as AccountClient | undefined;
    if (!client) continue;
    const all = client.all.bind(client);
    client.all = (filters = []) => all([{ dataSize: size }, ...filters]);
  }
}
