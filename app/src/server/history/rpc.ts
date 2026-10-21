/** A call to one of the history functions in Postgres (named arguments, jsonb or boolean result). */
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;
