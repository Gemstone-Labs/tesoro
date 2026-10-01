/** Solana devnet's genesis hash: the only cluster the keeper signs for. */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** Ethereum Hoodi testnet: the only EVM chain the keeper sends `reportYield` on. */
export const HOODI_CHAIN_ID = 560048;

/** Throws unless the RPC behind `conn` serves Solana devnet. */
export async function assertDevnet(conn: { getGenesisHash(): Promise<string> }, label: string): Promise<void> {
  const hash = await conn.getGenesisHash();
  if (hash !== DEVNET_GENESIS) throw new Error(`${label} RPC is not Solana devnet (genesis ${hash}); the keeper runs on devnet only`);
}

/** Throws unless the EVM RPC serves Hoodi. */
export async function assertHoodi(pub: { getChainId(): Promise<number> }): Promise<void> {
  const id = await pub.getChainId();
  if (id !== HOODI_CHAIN_ID) throw new Error(`EVM RPC is chain ${id}, not Hoodi (${HOODI_CHAIN_ID}); reportYield refused`);
}
