import type { Decorator } from "@storybook/nextjs-vite";
import { PublicKey } from "@solana/web3.js";
import { AuthContext } from "@/lib/auth/context";
import type { ChainSigner } from "@/games/block-puzzle/chain";
import type { EvmSigner } from "@/lib/auth/types";
import { authFor } from "../../support/auth";
import { DEMO_EVM } from "../../support/data";

const SIGNER: ChainSigner = { publicKey: PublicKey.default, signTransaction: async (tx) => tx, signMessage: async (m) => m };

const ADDRESS = DEMO_EVM.toLowerCase() as `0x${string}`;

const EVM: EvmSigner = {
  address: ADDRESS,
  account: ADDRESS,
  client: {} as EvmSigner["client"],
  clientFor: () => ({}) as ReturnType<EvmSigner["clientFor"]>,
  prepare: async () => {},
  source: "embedded",
};

/** Signed in with a wallet that can sign: the Match screens need one before they show anything. Signed out stays signed out. */
export const withSigner: Decorator = (Story, ctx) => {
  const mode = (ctx.parameters.auth ?? ctx.globals.auth ?? "signed-in") as Parameters<typeof authFor>[0];
  if (mode !== "signed-in") return Story();
  return (
    <AuthContext.Provider value={{ ...authFor(mode), signer: SIGNER, evm: EVM }}>
      <Story />
    </AuthContext.Provider>
  );
};
