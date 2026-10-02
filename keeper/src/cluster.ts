/** Solana devnet's genesis hash: the only cluster the keeper signs for. */
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
/** Ethereum Hoodi and HyperEVM testnet: the only EVM chains the keeper sends `reportYield` on. */
export const HOODI_CHAIN_ID = 560048;
export const HYPEREVM_CHAIN_ID = 998;

/** Throws unless the RPC behind `conn` serves Solana devnet. */
export async function assertDevnet(conn: { getGenesisHash(): Promise<string> }, label: string): Promise<void> {
  const hash = await conn.getGenesisHash();
  if (hash !== DEVNET_GENESIS) throw new Error(`${label} RPC is not Solana devnet (genesis ${hash}); the keeper runs on devnet only`);
}

async function assertChain(pub: { getChainId(): Promise<number> }, expected: number, name: string): Promise<void> {
  const id = await pub.getChainId();
  if (id !== expected) throw new Error(`EVM RPC is chain ${id}, not ${name} (${expected}); reportYield refused`);
}

/** Throws unless the EVM RPC serves Hoodi. */
export const assertHoodi = (pub: { getChainId(): Promise<number> }) => assertChain(pub, HOODI_CHAIN_ID, "Hoodi");

/** Throws unless the EVM RPC serves HyperEVM testnet. */
export const assertHyperEvm = (pub: { getChainId(): Promise<number> }) => assertChain(pub, HYPEREVM_CHAIN_ID, "HyperEVM testnet");
