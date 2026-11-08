/**
 * Byte length of the current layout of the accounts devnet still holds in older layouts after the economy upgrade
 * (tesoro_core `MatchState::SPACE`, `SourceState::SPACE`). Matches and Sources written by the earlier programs have
 * other lengths and cannot be decoded; a list of "every MatchState" would throw on the first one. Every
 * `core.account.<type>.all()` is therefore filtered to the current lengths (`onlyCurrentLayouts`), as Positions are
 * (`position-size.ts`).
 */
export const CURRENT_SIZE = { matchState: 840, sourceState: 170 } as const;

/**
 * Offer lengths this IDL decodes: 174 B, and 191 B once the W3 core's `grow_offer` appends `counted_in` and
 * `ticket_nonce` (17 B the decoder leaves unread). Devnet holds both while the W3 core runs there.
 */
export const OFFER_SIZES = [174, 191] as const;

const LISTED_SIZES: Record<string, readonly number[]> = { matchState: [CURRENT_SIZE.matchState], sourceState: [CURRENT_SIZE.sourceState], offerState: OFFER_SIZES };

type AccountClient = { all: (filters?: unknown[]) => Promise<unknown[]> };

/** Makes `program.account.<type>.all()` skip accounts of an older layout: one list per accepted length. */
export function onlyCurrentLayouts(program: { account: Record<string, unknown> }): void {
  for (const [name, sizes] of Object.entries(LISTED_SIZES)) {
    const client = program.account[name] as AccountClient | undefined;
    if (!client) continue;
    const all = client.all.bind(client);
    client.all = async (filters = []) => (await Promise.all(sizes.map((size) => all([{ dataSize: size }, ...filters])))).flat();
  }
}
