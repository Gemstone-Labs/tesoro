import "server-only";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TESORO_CORE_PROGRAM_ID } from "@/games/block-puzzle/chain";
import { DemoHttpError } from "../request-auth";
import { supabaseNotifyStore } from "../notify/supabase-store";
import { chain } from "../demo-advance";
import { inviteKeypair } from "./key";
import type { RedeemDeps } from "./redeem";
import { supabaseInviteStore } from "./supabase-store";

const seed = (...parts: Buffer[]) => PublicKey.findProgramAddressSync(parts, TESORO_CORE_PROGRAM_ID)[0];

/** The production wiring: Supabase stores, the Invite key from INVITE_SECRET_KEY, the cluster's RPC. */
export function redeemDeps(): RedeemDeps {
  const key = () => {
    try {
      return inviteKeypair(process.env.INVITE_SECRET_KEY);
    } catch (e) {
      console.error(`[invite] ${(e as Error).message}`);
      throw new DemoHttpError(503, "not-configured", "Invites are not set up on this server.");
    }
  };
  return {
    invites: supabaseInviteStore,
    notify: supabaseNotifyStore,
    accountExists: async (authority) => (await chain().conn.getAccountInfo(seed(Buffer.from("account"), new PublicKey(authority).toBuffer()))) !== null,
    buildCoSigned: async (authority) => {
      const invite = key();
      const player = new PublicKey(authority);
      const { conn, core } = chain();
      const account = seed(Buffer.from("account"), player.toBuffer());
      const ix = await core.methods
        .createAccount(Array(20).fill(0))
        .accountsPartial({ authority: player, account, basket: seed(Buffer.from("basket"), account.toBuffer()), spill: seed(Buffer.from("spill"), account.toBuffer()), inviteGate: seed(Buffer.from("invite_gate")), systemProgram: SystemProgram.programId })
        .remainingAccounts([{ pubkey: invite.publicKey, isSigner: true, isWritable: false }])
        .instruction();
      const tx = new Transaction().add(ix);
      tx.feePayer = player;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      tx.partialSign(invite);
      return tx.serialize({ requireAllSignatures: false }).toString("base64");
    },
  };
}
